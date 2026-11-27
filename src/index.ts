import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as core from "@actions/core";
import type { FeedEntry } from "@extractus/feed-extractor";
import { extract } from "@extractus/feed-extractor";
import { createRestAPIClient } from "masto";
import { mkdirp } from "mkdirp";

function sha256Hex(value: string | undefined | null): string {
  return createHash("sha256")
    .update(value ?? "", "utf8")
    .digest("hex");
}

export async function writeCache(
  cacheFile: string,
  cacheLimit: number,
  cache: string[]
): Promise<void> {
  try {
    // limit the cache
    const excessItems = cache.length - cacheLimit;
    if (excessItems > 0) {
      core.notice(`Cache limit reached. Removing ${excessItems} items.`);
    }
    const keptCache = excessItems > 0 ? cache.slice(-cacheLimit) : cache;

    // make sure the cache directory exists
    const dirIndex = cacheFile.lastIndexOf("/");
    if (dirIndex > 0) {
      await mkdirp(cacheFile.slice(0, dirIndex));
    }

    // write the cache
    await writeFile(cacheFile, JSON.stringify(keptCache));
  } catch (e) {
    core.setFailed(`Failed to write cache file: ${(<Error>e).message}`);
  }
}

export async function postItems(
  apiEndpoint: string,
  apiToken: string,
  rss: FeedEntry[],
  visibility: "public" | "unlisted" | "private" | "direct",
  cache: string[]
) {
  // authenticate with mastodon
  const masto = createRestAPIClient({
    url: apiEndpoint,
    accessToken: apiToken,
  });

  // post the new items sequentially to preserve feed order and avoid Mastodon API rate limits
  for (const item of rss) {
    try {
      const hash = sha256Hex(item.link);

      // post the item
      // biome-ignore lint/performance/noAwaitInLoops: sequential posting preserves feed order and respects API rate limits
      const res = await masto.v1.statuses.create({
        status: `${item.title} ${item.link}`,
        visibility,
      });
      core.debug(`Response:\n\n${JSON.stringify(res, null, 2)}`);

      // add the item to the cache
      cache.push(hash);
    } catch (e) {
      core.setFailed(`Failed to post item: ${(<Error>e).message}`);
    }
  }
}

export function filterCachedItems(
  rss: FeedEntry[],
  cache: string[]
): FeedEntry[] {
  if (!cache.length) {
    return rss;
  }

  const filteredRss: FeedEntry[] = [];
  for (const item of rss) {
    const hash = sha256Hex(item.link);
    if (!cache.includes(hash)) {
      filteredRss.push(item);
    }
  }

  core.debug(
    JSON.stringify(
      `Post-filter feed items:\n\n${JSON.stringify(filteredRss, null, 2)}`
    )
  );
  return filteredRss;
}

export async function getRss(
  rssFeed: string
): Promise<FeedEntry[] | undefined> {
  try {
    const feed = await extract(rssFeed);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: malformed feeds can omit or null entries at runtime
    const rss = feed?.entries ?? [];
    core.debug(
      JSON.stringify(
        `Pre-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`
      )
    );
    return rss;
  } catch (e) {
    core.setFailed(`Failed to parse RSS feed: ${(<Error>e).message}`);
    return undefined;
  }
}

export async function getCache(
  cacheFile: string
): Promise<{ cache: string[]; existed: boolean; failed: boolean }> {
  try {
    const cache = JSON.parse(await readFile(cacheFile, "utf-8")) as string[];
    core.debug(`Cache: ${JSON.stringify(cache)}`);
    return { cache, existed: true, failed: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      core.notice(
        `Cache file not found. Creating new cache file at ${cacheFile}.`
      );
      return { cache: [], existed: false, failed: false };
    }
    core.setFailed(`Failed to read cache file: ${(<Error>e).message}`);
    return { cache: [], existed: false, failed: true };
  }
}

export async function main(): Promise<void> {
  // get the rss feed
  const rssFeed = core.getInput("rss-feed");
  core.debug(`rssFeed: ${rssFeed}`);
  let rss = await getRss(rssFeed);

  if (!rss) {
    return;
  }

  if (rss.length === 0) {
    core.notice("No new items to post.");
    return;
  }

  // get variables from environment
  const apiEndpoint = core.getInput("api-endpoint");
  core.debug(`apiEndpoint: ${apiEndpoint}`);
  const apiToken = core.getInput("api-token");
  core.debug(`apiToken: ${apiToken}`);
  const cacheFile = core.getInput("cache-file");
  core.debug(`cacheFile: ${cacheFile}`);
  const cacheLimit = Number.parseInt(core.getInput("cache-limit"), 10);
  core.debug(`cacheLimit: ${cacheLimit}`);
  const statusVisibility: "public" | "unlisted" | "private" | "direct" =
    core.getInput("status-visibility", {
      trimWhitespace: true,
    }) as "public" | "unlisted" | "private" | "direct";
  core.debug(`statusVisibility: ${statusVisibility}`);

  // get the cache
  const { cache, existed, failed } = await getCache(cacheFile);

  // a corrupt cache means we cannot dedupe: post nothing rather than the whole backlog
  if (failed) {
    return;
  }

  // first sighting of this cache: record everything as seen and post nothing
  if (!existed) {
    const baseline = (<FeedEntry[]>rss).map((entry) => sha256Hex(entry.link));
    await writeCache(cacheFile, cacheLimit, [...cache, ...baseline]);
    core.notice("First run: feed baseline recorded. No items posted.");
    return;
  }

  // filter out the cached items
  rss = filterCachedItems(<FeedEntry[]>rss, cache);

  // if there are no new items, we're done
  if (rss.length === 0) {
    core.notice("No new items to post.");
    return;
  }

  // post the new items
  await postItems(
    apiEndpoint,
    apiToken,
    <FeedEntry[]>rss,
    statusVisibility,
    cache
  );

  // write the cache
  await writeCache(cacheFile, cacheLimit, cache);
}

main();
