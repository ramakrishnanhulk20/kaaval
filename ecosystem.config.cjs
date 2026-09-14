// pm2 keeps the engine running across crashes and reboots. Secrets are not here: the
// engine reads .env itself through dotenv, so this file is safe to publish.
const { resolve } = require("node:path");

// The site is a Next.js app in web/ and Next only reads env files from its own folder,
// so the site's process is handed the repository's .env here; on Vercel the same names
// come from the dashboard.
const siteEnv = require("dotenv").config({ path: resolve(__dirname, ".env") }).parsed ?? {};

module.exports = {
  apps: [
    {
      name: "kaaval-web",
      script: resolve(__dirname, "web/node_modules/next/dist/bin/next"),
      args: "dev --webpack",
      cwd: resolve(__dirname, "web"),
      env: { ...siteEnv, KAAVAL_PROOF_RUNNER: "local" },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      out_file: resolve(__dirname, "data/state/logs/web-out.log"),
      error_file: resolve(__dirname, "data/state/logs/web-error.log"),
      merge_logs: true,
      time: true,
      windowsHide: true,
    },
    {
      name: "kaaval",
      // The same thing `npx tsx scripts/run-engine.ts` does, named directly. pm2 on
      // Windows hands script to node, and node cannot read npx.cmd.
      script: resolve(__dirname, "node_modules/tsx/dist/cli.mjs"),
      args: "scripts/run-engine.ts",
      cwd: __dirname,
      autorestart: true,
      // Twenty restarts with half a minute between them is about ten minutes of trying.
      // Past that the problem is not going to fix itself and a human should look.
      max_restarts: 20,
      restart_delay: 30000,
      out_file: resolve(__dirname, "data/state/logs/kaaval-out.log"),
      error_file: resolve(__dirname, "data/state/logs/kaaval-error.log"),
      merge_logs: true,
      time: true,
      kill_timeout: 120000,
      windowsHide: true,
    },
    {
      name: "kaaval-publisher",
      script: resolve(__dirname, "node_modules/tsx/dist/cli.mjs"),
      args: "scripts/publish-record.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 30000,
      out_file: resolve(__dirname, "data/state/logs/publisher-out.log"),
      error_file: resolve(__dirname, "data/state/logs/publisher-error.log"),
      merge_logs: true,
      time: true,
      // A cycle runs the three proofs and a push, so it is given room to finish on a stop.
      kill_timeout: 120000,
      windowsHide: true,
    },
  ],
};
