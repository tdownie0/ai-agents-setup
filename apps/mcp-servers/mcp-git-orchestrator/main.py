import os
import argparse
import threading
from dbos import DBOS, DBOSConfig

import workflows
from server import mcp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()

    if args.worker:
        dbos_config: DBOSConfig = {
            "name": "mcp-git-orchestrator",
            "system_database_url": os.environ.get("DBOS_SYSTEM_DATABASE_URL"),
        }
        DBOS(config=dbos_config)
        DBOS.listen_queues([workflows.orchestrator_queue])
        DBOS.launch()
        stop_event = threading.Event()
        try:
            stop_event.wait()
        except (KeyboardInterrupt, SystemExit):
            print("Stopping worker...")
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
