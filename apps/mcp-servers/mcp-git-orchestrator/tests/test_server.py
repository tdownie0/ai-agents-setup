import json
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path

import provider
import main
from engine import CommandResult


## 1. Port Selection (Testing provider.py)
@patch("provider.r")
@patch("provider.subprocess.run")
@patch("provider.socket.socket")
def test_find_available_port_block(mock_socket, mock_docker, mock_redis):
    # Setup Socket: return 1 (Port is free)
    mock_socket.return_value.__enter__.return_value.connect_ex.return_value = 1

    # Setup Docker: No ports currently in use
    mock_docker.return_value = MagicMock(stdout="", returncode=0)

    # Setup Redis
    mock_redis.set.return_value = True
    mock_redis.smembers.return_value = set()
    mock_redis.get.return_value = "locked"

    fe, be, db = provider.find_available_port_block(5000)

    # Assertions
    assert fe == 5000
    assert be == 6000
    assert db == 7000

    # Ensure we used the distributed lock correctly
    mock_redis.set.assert_called_with(provider.PORT_LOCK_KEY, "locked", nx=True, ex=20)
    mock_redis.delete.assert_called_with(provider.PORT_LOCK_KEY)


## 2. Initialize Worktree (Behavior Check)
@patch("main.find_available_port_block")
@patch("main.DockerComposeRunner")
@patch("main.GitRunner")
@patch("main.Path.exists")
@patch("main.Path.read_text")
def test_initialize_worktree_recovered(
    mock_read, mock_exists, mock_git, mock_compose, mock_port_find
):
    mock_exists.return_value = True

    def side_effect_read():
        return json.dumps(
            {"frontend": 5174, "backend": 6174, "db": 7174, "branch": "test-feature"}
        )

    mock_read.side_effect = side_effect_read

    mock_composer_instance = mock_compose.return_value
    mock_composer_instance.up.return_value = CommandResult("Success", "", 0, "up")

    result = main.initialize_worktree("test-feature")

    assert "✅ Environment recovered at" in result
    assert "Ports: FE:5174, BE:6174, DB:7174" in result


## 3. Parallel Conflict Simulation
@patch("provider.r")
@patch("provider.socket.socket")
@patch("provider.subprocess.run")
def test_port_block_skips_redis_registry(mock_run, mock_socket, mock_redis):
    mock_socket.return_value.__enter__.return_value.connect_ex.return_value = 1
    mock_run.return_value = MagicMock(stdout="", returncode=0)
    mock_redis.set.return_value = True

    # Simulate that 5000 is already in the Redis registry
    mock_redis.smembers.return_value = {"5000"}
    mock_redis.get.return_value = "locked"

    fe, be, db = provider.find_available_port_block(5000)

    # It should skip 5000 and pick 5001
    assert fe == 5001
    assert be == 6001
    assert db == 7001
