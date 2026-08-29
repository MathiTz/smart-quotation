import { execFileSync } from "node:child_process";

/**
 * Blocks until Postgres inside the compose container answers, so that `db:push`
 * cannot run against a database that is listening on the port but has not
 * finished starting.
 *
 * `docker compose up -d` returns as soon as the container is *created*, which is
 * several seconds before Postgres is ready to accept connections. Without this
 * wait, `pnpm setup` on a cold machine fails perhaps one run in three, and the
 * error it gives ("the database system is starting up") looks like a
 * misconfiguration rather than a race.
 *
 * `pg_isready` is asked inside the container rather than over the mapped port
 * because the official image starts a temporary server on a Unix socket to run
 * its init scripts. That server accepts local connections while the real one is
 * still unavailable from outside, so probing the host port can report ready too
 * early.
 */
const CONTAINER = "sq-postgres";
const USER = "sq";
const DATABASE = "smart_quotation";
const TIMEOUT_MS = 60_000;
const POLL_MS = 1000;

const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline) {
  try {
    execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-U", USER, "-d", DATABASE], {
      stdio: "ignore",
    });
    console.log("postgres ready");
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

console.error(
  `postgres did not become ready within ${TIMEOUT_MS / 1000}s. ` +
    `Check "docker compose ps" and "docker compose logs postgres".`,
);
process.exit(1);
