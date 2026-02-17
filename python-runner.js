import { spawn } from "child_process";

export class PythonRunner {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
  }

  runStalker(opts) {
    return new Promise((resolve, reject) => {
      const py = spawn("python3", [
        "python/stalker_engine.py",
        this.sessionKey,
        opts.portal,
        opts.mac,
        opts.timezone
      ]);

      py.stdout.on("data", d => console.log(d.toString()));
      py.stderr.on("data", d => console.error(d.toString()));

      py.on("close", () => resolve());
    });
  }
}
