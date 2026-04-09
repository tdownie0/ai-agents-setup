import os
import subprocess
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Optional


@dataclass
class CommandResult:
    stdout: str
    stderr: str
    returncode: int
    cmd: str


class Executor:
    def __init__(self, cwd: Path, env: Optional[Dict[str, str]] = None):
        self.cwd = cwd
        # Use .copy() to avoid mutating the global environment accidentally
        self.env = env if env is not None else os.environ.copy()

    def run(
        self, args: List[str], check: bool = True, timeout: int = 300
    ) -> CommandResult:
        try:
            res = subprocess.run(
                args,
                cwd=self.cwd,
                env=self.env,
                capture_output=True,
                text=True,
                check=check,
                timeout=timeout,
            )
            return CommandResult(res.stdout, res.stderr, res.returncode, " ".join(args))
        except subprocess.CalledProcessError as e:
            # Capture both stdout and stderr in your exception
            # debugging logs in containerized envs is a nightmare without both.
            error_msg = f"Command failed: {' '.join(args)}\nSTDOUT: {e.stdout}\nSTDERR: {e.stderr}"
            raise RuntimeError(error_msg) from e


class DockerComposeRunner:
    def __init__(
        self,
        project_name: str,
        worktree_path: Path,
        env: Optional[Dict[str, str]] = None,
    ):
        self.executor = Executor(cwd=worktree_path, env=env)

        self.base_cmd = ["docker", "compose", "-p", project_name]

    def exec_pnpm(self, service: str, pnpm_args: List[str]):
        return self.executor.run(
            [*self.base_cmd, "exec", "-T", service, "pnpm", *pnpm_args]
        )

    def up(self, file: str = "docker-compose.feature.yml"):
        return self.executor.run([*self.base_cmd, "-f", file, "up", "-d"])

    def ps(self):
        return self.executor.run([*self.base_cmd, "ps"])

    def down(self, volumes: bool = True):
        cmd = [*self.base_cmd, "down"]
        if volumes:
            cmd.append("-v")
        return self.executor.run(cmd)

    def logs(self, tail: int = 50, service: Optional[str] = None):
        cmd = [*self.base_cmd, "logs", f"--tail={tail}", "--no-color"]
        if service:
            cmd.append(service)
        return self.executor.run(cmd)


class GitRunner:
    def __init__(self, repo_path: Path):
        self.executor = Executor(cwd=repo_path)

    def run_git(self, command: str, args: List[str]):
        return self.executor.run(["git", command, *args])
