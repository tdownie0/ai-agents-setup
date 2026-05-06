import os
import subprocess
import httpx
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

        self.env_file = worktree_path / ".env"

        self.base_cmd = [
            "docker",
            "compose",
            "--env-file",
            str(self.env_file),
            "-p",
            project_name,
        ]

    def exec_pnpm(self, service: str, pnpm_args: List[str]):
        return self.executor.run(
            [*self.base_cmd, "exec", "-T", service, "pnpm", *pnpm_args]
        )

    def up(self, file: str = "infra/docker-compose.feature.yml"):
        return self.executor.run([*self.base_cmd, "-f", file, "up", "-d"])

    def ps(self):
        return self.executor.run([*self.base_cmd, "ps"])

    def down(
        self, file: str = "infra/docker-compose.feature.yml", volumes: bool = True
    ):
        cmd = [*self.base_cmd, "-f", file, "down"]
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


class LokiClient:
    def __init__(self, base_url: str = "http://loki:3100"):
        self.base_url = base_url

    def get_service_logs(self, service_name: str, tail: int = 50) -> str:
        """Queries Loki for logs filtered by service_name."""
        query = f'{{service_name=~".*{service_name}.*"}}'

        try:
            response = httpx.get(
                f"{self.base_url}/loki/api/v1/query_range",
                params={"query": query, "limit": tail, "direction": "backward"},
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()

            lines = []
            for result in data.get("data", {}).get("result", []):
                for val in result.get("values", []):
                    lines.append(val[1])

            return (
                "\n".join(reversed(lines))
                if lines
                else f"No logs found for {service_name}."
            )

        except Exception as e:
            return f"Loki Query Error: {str(e)}"
