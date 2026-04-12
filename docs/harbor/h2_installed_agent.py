import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, EnvVar, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class H2InstalledAgent(BaseInstalledAgent):
    """
    Sample Harbor custom installed agent that invokes `h2 harbor-run`.

    This is intended as a companion wrapper for harness2's Harbor integration,
    not as a built-in Harbor agent.
    """

    CLI_FLAGS = [
        CliFlag(
            "mode",
            cli="--mode",
            type="enum",
            choices=["study", "plan", "direct"],
            default="study",
        ),
        CliFlag(
            "reasoning_effort",
            cli="--reasoning-effort",
            type="enum",
            choices=["off", "low", "medium", "high"],
            default="medium",
        ),
        CliFlag(
            "web_search_mode",
            cli="--web-search-mode",
            type="enum",
            choices=["disabled", "cached", "live"],
            default=None,
        ),
        CliFlag(
            "thinking",
            cli="--thinking",
            type="bool",
            default=True,
        ),
    ]

    ENV_VARS = [
        EnvVar(
            "runtime_bundle_path",
            env="H2_RUNTIME_BUNDLE_PATH",
            type="str",
            default=None,
            env_fallback="H2_RUNTIME_BUNDLE_PATH",
        ),
        EnvVar(
            "install_spec",
            env="H2_INSTALL_SPEC",
            type="str",
            default="github:your-org/harness2",
            env_fallback="H2_INSTALL_SPEC",
        ),
        EnvVar(
            "auth_db_path",
            env="H2_AUTH_DB_PATH",
            type="str",
            default=None,
            env_fallback="H2_AUTH_DB_PATH",
        ),
        EnvVar(
            "openai_base_url",
            env="OPENAI_BASE_URL",
            type="str",
            default=None,
            env_fallback="OPENAI_BASE_URL",
        ),
    ]

    @staticmethod
    def name() -> str:
        return "h2"

    @staticmethod
    def _default_runtime_bundle_path() -> Path:
        return Path(__file__).resolve().parents[2] / ".artifacts" / "h2-harbor-runtime.tar.gz"

    @staticmethod
    def _default_auth_db_path() -> Path:
        return Path.home() / ".h2" / "auth.sqlite"

    def _resolved_runtime_bundle_path(self) -> Path | None:
        resolved_env = self.resolve_env_vars()
        runtime_bundle_path = resolved_env.get("H2_RUNTIME_BUNDLE_PATH")
        if runtime_bundle_path:
            host_bundle_path = Path(runtime_bundle_path).expanduser()
            return host_bundle_path if host_bundle_path.exists() else None

        default_bundle_path = self._default_runtime_bundle_path()
        return default_bundle_path if default_bundle_path.exists() else None

    def _resolved_auth_db_path(self) -> Path | None:
        resolved_env = self.resolve_env_vars()
        auth_db_path = resolved_env.get("H2_AUTH_DB_PATH")
        if auth_db_path:
            host_auth_path = Path(auth_db_path).expanduser()
            return host_auth_path if host_auth_path.is_file() else None

        default_auth_path = self._default_auth_db_path()
        return default_auth_path if default_auth_path.is_file() else None

    async def install(self, environment: BaseEnvironment) -> None:
        runtime_bundle_path = self._resolved_runtime_bundle_path()
        runtime_root = "/opt/h2-runtime"

        await self.exec_as_root(
            environment,
            command="""
set -euo pipefail
if command -v git >/dev/null 2>&1; then
  exit 0
fi

if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache git
    exit 0
  fi
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git
  exit 0
fi

if command -v yum >/dev/null 2>&1; then
  yum install -y git
  exit 0
fi

if command -v dnf >/dev/null 2>&1; then
  dnf install -y git
  exit 0
fi

echo "git is required for h2 Harbor runs and could not be installed automatically." >&2
exit 1
""",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        if runtime_bundle_path is None:
            default_bundle_path = self._default_runtime_bundle_path()
            raise FileNotFoundError(
                "No Harbor runtime bundle was found. Set H2_RUNTIME_BUNDLE_PATH or build the default bundle at "
                f"{default_bundle_path}"
            )

        if runtime_bundle_path.is_file():
            bundle_target = f"/tmp/{runtime_bundle_path.name}"
            await environment.upload_file(runtime_bundle_path, bundle_target)
            await self.exec_as_root(
                environment,
                command=f"""
set -euo pipefail
rm -rf {runtime_root}
mkdir -p {runtime_root}
tar -xzf {shlex.quote(bundle_target)} -C {runtime_root} --strip-components=1
chown -R {environment.default_user or 'root'}:{environment.default_user or 'root'} {runtime_root}
""",
            )
        else:
            await self.exec_as_root(
                environment,
                command=f"rm -rf {runtime_root} && mkdir -p {runtime_root}",
            )
            await environment.upload_dir(runtime_bundle_path, runtime_root)
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment,
                    command=f"chown -R {environment.default_user}:{environment.default_user} {runtime_root}",
                )

        await self.exec_as_agent(
            environment,
            command=f"""
set -euo pipefail
if [ ! -x {runtime_root}/bin/h2 ]; then
  echo "Runtime bundle missing launcher: {runtime_root}/bin/h2" >&2
  exit 1
fi
H2_COMMAND_SHELL=bash {runtime_root}/bin/h2 help >/dev/null
""",
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        resolved_env = self.resolve_env_vars()
        instruction_target = "/tmp/h2-instruction.md"
        stdout_json_target = "/logs/agent/harbor-run.stdout.json"
        auth_db_uploaded_target = "/tmp/h2-auth.uploaded.sqlite"
        auth_db_target = "/tmp/h2-auth.sqlite"

        await self.exec_as_agent(
            environment,
            command=f"cat > {instruction_target} <<'EOF'\n{instruction}\nEOF",
        )

        env = {}
        env["H2_COMMAND_SHELL"] = "bash"
        auth_db_source = self._resolved_auth_db_path()
        if auth_db_source:
            await environment.upload_file(auth_db_source, auth_db_uploaded_target)
            auth_db_owner = environment.default_user or "root"
            await self.exec_as_root(
                environment,
                command=f"""
set -euo pipefail
cp {auth_db_uploaded_target} {auth_db_target}
chown {auth_db_owner}:{auth_db_owner} {auth_db_target}
chmod 600 {auth_db_target}
""",
            )
            env["H2_AUTH_DB_PATH"] = auth_db_target
        openai_base_url = resolved_env.get("OPENAI_BASE_URL")
        if openai_base_url:
            env["OPENAI_BASE_URL"] = openai_base_url

        mode_flag = ""
        harbor_flags = []
        mode = self._resolved_flags.get("mode")
        if mode:
            mode_flag = f"--mode {mode}"
        reasoning_effort = self._resolved_flags.get("reasoning_effort")
        if reasoning_effort:
            harbor_flags.append(f"--reasoning-effort {reasoning_effort}")
        if self.model_name:
            harbor_flags.append(f"--model {shlex.quote(self.model_name.split('/', 1)[-1])}")
        web_search_mode = self._resolved_flags.get("web_search_mode")
        if web_search_mode:
            harbor_flags.append(f"--web-search-mode {web_search_mode}")
        if self._resolved_flags.get("thinking") is True:
            harbor_flags.append("--thinking")
        else:
            harbor_flags.append("--no-thinking")

        h2_command = "/opt/h2-runtime/bin/h2"

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "mkdir -p /logs/agent; "
                f"{h2_command} "
                f"{mode_flag} "
                "harbor-run "
                f"{' '.join(harbor_flags)} "
                "--output-dir /logs/agent "
                f"--instruction-file {instruction_target} "
                "--json "
                f"> {stdout_json_target}"
            ),
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        summary_path = self.logs_dir / "summary.json"
        if not summary_path.exists():
            return

        summary = json.loads(summary_path.read_text())
        context.metadata = {
            "h2_session_id": summary.get("sessionId"),
            "h2_output_dir": summary.get("outputDir"),
            "h2_runtime": summary.get("runtime"),
            "h2_artifacts": summary.get("artifacts"),
        }
