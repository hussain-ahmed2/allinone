import { createConnection } from "node:net";

async function wait(port, label) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      console.log(
        label + " ready in " + Math.round((Date.now() - (deadline - 90_000)) / 1000) + "s",
      );
      return;
    } catch {
      if (Date.now() > deadline) {
        console.error(label + " timed out");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

await Promise.all([
  wait(5433, "postgres"),
  wait(27017, "mongo"),
  wait(3307, "mysql"),
  wait(6380, "redis"),
]);
process.exit(0);
