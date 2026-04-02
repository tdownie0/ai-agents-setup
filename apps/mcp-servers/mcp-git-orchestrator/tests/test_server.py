import json
from unittest.mock import patch, MagicMock
from main import find_available_port_block, initialize_worktree


## 1. Port Selection (Logic Check)
@patch("subprocess.run")
@patch("socket.socket")
def test_find_available_port_block(mock_socket, mock_docker):
    mock_socket.return_value.__enter__.return_value.connect_ex.return_value = 1
    mock_docker.return_value = MagicMock(stdout="", returncode=0)

    fe, be, db = find_available_port_block(5000)

    assert fe == 5000
    assert be == 6000
    assert db == 7000


## 2. Initialize Worktree (Behavior Check)
@patch("subprocess.run")
@patch("pathlib.Path.exists")
@patch("pathlib.Path.write_text")
@patch("pathlib.Path.read_text")
def test_initialize_worktree_read_only(mock_read, mock_write, mock_exists, mock_run):
    # Setup mock to simulate a "Recovered" path (Path exists)
    mock_exists.return_value = True

    # Provide valid JSON for the services_file.read_text() call
    mock_read.return_value = json.dumps(
        {"frontend": 5174, "backend": 6174, "db": 7174, "branch": "test-feature"}
    )

    mock_run.return_value = MagicMock(stdout="Success", stderr="", returncode=0)

    result = initialize_worktree("test-feature")

    # Assertions
    assert "✅ Environment recovered" in result
    assert "Frontend:5174" in result

    # Verify docker compose was the last thing called
    last_call = mock_run.call_args_list[-1][0][0]

    assert "docker" in last_call
    assert "up" in last_call
