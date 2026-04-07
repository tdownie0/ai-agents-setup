import json
from unittest.mock import patch, MagicMock
from main import find_available_port_block, initialize_worktree


## 1. Port Selection (Logic Check)
@patch("main.r")
@patch("main.subprocess.run")
@patch("main.socket.socket")
def test_find_available_port_block(mock_socket, mock_docker, mock_redis):
    # Setup Socket: return 1 (Port is free)

    mock_socket.return_value.__enter__.return_value.connect_ex.return_value = 1
    # Setup Docker: No ports currently in use

    mock_docker.return_value = MagicMock(stdout="", returncode=0)

    # Setup Redis:
    mock_redis.set.return_value = True
    mock_redis.smembers.return_value = set()

    mock_redis.get.return_value = "locked"

    fe, be, db = find_available_port_block(5000)

    # Assertions
    assert fe == 5000
    assert be == 6000
    assert db == 7000

    # Match the ACTUAL code's ex=20 instead of 30
    mock_redis.set.assert_called_with("lock:port_allocation", "locked", nx=True, ex=20)

    mock_redis.delete.assert_called_with("lock:port_allocation")


## 2. Initialize Worktree (Behavior Check)
@patch("main.r")
@patch("main.subprocess.run")
@patch("main.Path.exists")
@patch("main.Path.write_text")
@patch("main.Path.read_text")
def test_initialize_worktree_recovered(
    mock_read, mock_write, mock_exists, mock_run, mock_redis
):
    # Setup: Path exists (Recovery mode)
    mock_exists.return_value = True

    # Mock services.json content
    mock_read.return_value = json.dumps(
        {"frontend": 5174, "backend": 6174, "db": 7174, "branch": "test-feature"}
    )

    mock_run.return_value = MagicMock(stdout="Success", stderr="", returncode=0)

    result = initialize_worktree("test-feature")

    # Match the ACTUAL code's return string
    assert "✅ Environment recovered and started" in result
    assert "Frontend:5174" in result


## 3. Parallel Conflict Simulation
@patch("main.r")
@patch("main.socket.socket")
@patch("main.subprocess.run")
def test_port_block_skips_redis_registry(mock_run, mock_socket, mock_redis):

    mock_socket.return_value.__enter__.return_value.connect_ex.return_value = 1
    mock_run.return_value = MagicMock(stdout="", returncode=0)
    mock_redis.set.return_value = True

    # Simulate that 5000 is already in the Redis registry
    mock_redis.smembers.return_value = {"5000"}

    fe, be, db = find_available_port_block(5000)

    # It should skip 5000 and pick 5001
    assert fe == 5001
    assert be == 6001
    assert db == 7001
