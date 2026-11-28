// Deletes every status on the mastofeedbot Mastodon account, 1 per second, with 20s backoff on rate limits.
// Uses MFB_TOKEN from the environment (write:statuses scope). Public listing needs no auth.
const TOKEN = process.env.MFB_TOKEN;
if (!TOKEN) {
  console.error("Set MFB_TOKEN to an access token with write:statuses scope.");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lookup = await fetch(
  "https://mastodon.social/api/v1/accounts/lookup?acct=mastofeedbot"
);
const acct = await lookup.json();
if (!acct.id) {
  console.error("Could not resolve the @mastofeedbot account.");
  process.exit(1);
}
console.log("account:", acct.id, "statuses_count:", acct.statuses_count);

let deleted = 0;
let rateLimited = 0;

for (let round = 0; round < 15; round += 1) {
  const url = new URL(
    `https://mastodon.social/api/v1/accounts/${acct.id}/statuses`
  );
  url.searchParams.set("limit", "100");
  const batch = await (await fetch(url)).json();
  if (!batch.length) break;
  for (const st of batch) {
    const res = await fetch(
      `https://mastodon.social/api/v1/statuses/${st.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }
    );
    if (res.ok) {
      deleted += 1;
      process.stdout.write("D");
    } else if (res.status === 429) {
      rateLimited += 1;
      process.stdout.write("4");
      await sleep(20_000);
    } else {
      process.stdout.write(`?${res.status}`);
    }
    await sleep(1_000);
  }
  console.log(
    `\nround ${round}: deleted=${deleted} rateLimited=${rateLimited}`
  );
  if (rateLimited > 50) {
    console.log("persistent rate limits; rerun later to continue.");
    break;
  }
}
console.log("TOTAL deleted this run:", deleted, "| rateLimited:", rateLimited);
