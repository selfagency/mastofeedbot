import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
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
  cache: string[],
  lastRun: Date
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

    // write the cache atomically: temp file first, then rename
    const tempFile = `${cacheFile}.tmp`;
    await writeFile(
      tempFile,
      JSON.stringify({ lastRun: lastRun.toISOString(), seen: keptCache })
    );
    await rename(tempFile, cacheFile);
  } catch (e) {
    core.setFailed(`Failed to write cache file: ${(<Error>e).message}`);
  }
}

export interface PostSummary {
  aborted: boolean;
  failed: number;
  posted: number;
}

function statusText(item: FeedEntry): string {
  return item.title ? `${item.title} ${item.link}` : `${item.link}`;
}

export async function postItems(
  apiEndpoint: string,
  apiToken: string,
  rss: FeedEntry[],
  visibility: "public" | "unlisted" | "private" | "direct",
  cache: string[]
): Promise<PostSummary> {
  // authenticate with mastodon
  const masto = createRestAPIClient({
    url: apiEndpoint,
    accessToken: apiToken,
  });

  // post the new items sequentially to preserve feed order and avoid Mastodon API rate limits
  let posted = 0;
  let failed = 0;
  let aborted = false;
  let lastError = "";
  for (const item of rss) {
    try {
      const hash = sha256Hex(item.link);

      // post the item
      // biome-ignore lint/performance/noAwaitInLoops: sequential posting preserves feed order and respects API rate limits
      const res = await masto.v1.statuses.create({
        status: statusText(item),
        visibility,
      });
      core.debug(`Response:\n\n${JSON.stringify(res, null, 2)}`);

      // add the item to the cache
      cache.push(hash);
      posted++;
    } catch (e) {
      failed++;
      lastError = (<Error>e).message;
      const statusCode = (e as { statusCode?: number }).statusCode;
      core.warning(`Failed to post ${item.title ?? item.link}: ${lastError}`);
      // stop the run on rate limits so items outside the window stay uncached for the next run
      if (statusCode === 429 || statusCode === 503) {
        aborted = true;
        break;
      }
    }
  }

  if (aborted) {
    core.setFailed(
      `Stopped after Mastodon rate limit (HTTP 429/503). ${posted} posted, ${rss.length - posted} left for the next run. Last error: ${lastError}`
    );
  } else if (failed > 0) {
    core.setFailed(
      `Failed to post ${failed} of ${rss.length} items. Last error: ${lastError}`
    );
  }

  return { posted, failed, aborted };
}

export function filterCachedItems(
  rss: FeedEntry[],
  cache: string[],
  lastRun?: Date
): FeedEntry[] {
  if (!cache.length) {
    return rss;
  }

  const filteredRss: FeedEntry[] = [];
  for (const item of rss) {
    if (lastRun && item.published) {
      const publishedAt = new Date(item.published);
      if (!Number.isNaN(publishedAt.getTime()) && publishedAt <= lastRun) {
        continue;
      }
    }
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

export async function getCache(cacheFile: string): Promise<{
  cache: string[];
  existed: boolean;
  failed: boolean;
  lastRun: Date;
}> {
  try {
    const stored = JSON.parse(await readFile(cacheFile, "utf-8")) as
      | string[]
      | { lastRun: string; seen: string[] };
    // legacy: plain array from earlier versions; migrates with a fresh lastRun
    if (Array.isArray(stored)) {
      core.debug(`Cache (legacy): ${JSON.stringify(stored)}`);
      return {
        cache: stored,
        existed: true,
        failed: false,
        lastRun: new Date(),
      };
    }
    const parsedRun = new Date(String(stored.lastRun));
    core.debug(`Cache: ${JSON.stringify(stored.seen)}`);
    return {
      cache: stored.seen ?? [],
      existed: true,
      failed: false,
      lastRun: Number.isNaN(parsedRun.getTime()) ? new Date() : parsedRun,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      core.notice(
        `Cache file not found. Creating new cache file at ${cacheFile}.`
      );
      return { cache: [], existed: false, failed: false, lastRun: new Date() };
    }
    core.setFailed(`Failed to read cache file: ${(<Error>e).message}`);
    return { cache: [], existed: false, failed: true, lastRun: new Date() };
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
  const apiToken = core.getInput("api-token");

  // never log secrets: the token must not reach the debug log
  const cacheFile = core.getInput("cache-file");
  const cacheLimit = Number.parseInt(core.getInput("cache-limit"), 10);
  const dryRunInput = core.getBooleanInput("dry-run");
  const dryRun = dryRunInput === true || (dryRunInput as unknown) === "true";
  const statusVisibility: "public" | "unlisted" | "private" | "direct" =
    core.getInput("status-visibility", {
      trimWhitespace: true,
    }) as "public" | "unlisted" | "private" | "direct";
  core.debug(
    `mode: ${dryRun ? "dry run" : "live"}, visibility: ${statusVisibility}`
  );

  // get the cache
  const { cache, existed, failed, lastRun } = await getCache(cacheFile);

  // a corrupt cache means we cannot dedupe: post nothing rather than the whole backlog
  if (failed) {
    return;
  }

  // first sighting of this cache: record everything as seen and post nothing
  if (!existed) {
    const baseline = (<FeedEntry[]>rss).map((entry) => sha256Hex(entry.link));
    if (dryRun) {
      core.notice(
        `Dry run: cold cache — the first live run would establish a baseline and post nothing. Feed currently has ${(<FeedEntry[]>rss).length} item(s).`
      );
    } else {
      await writeCache(
        cacheFile,
        cacheLimit,
        [...cache, ...baseline],
        new Date()
      );
      core.notice("First run: feed baseline recorded. No items posted.");
    }
    await writeSummary(
      rssFeed,
      dryRun,
      "baseline",
      0,
      (<FeedEntry[]>rss).length
    );
    return;
  }

  // nothing older than the last run may be posted, regardless of cache size
  rss = filterCachedItems(<FeedEntry[]>rss, cache, lastRun);

  // if there are no new items, we're done
  if (rss.length === 0) {
    core.notice("No new items to post.");
    await writeSummary(rssFeed, dryRun, "clean", 0, 0);
    return;
  }

  // dry run: report what would be posted and touch nothing
  if (dryRun) {
    core.notice(
      `Dry run: ${(<FeedEntry[]>rss).length} item(s) would be posted.`
    );
    await writeSummary(rssFeed, true, "dry-run", 0, (<FeedEntry[]>rss).length);
    return;
  }

  // post the new items
  const summary = await postItems(
    apiEndpoint,
    apiToken,
    <FeedEntry[]>rss,
    statusVisibility,
    cache
  );

  // write the cache (even on abort: successfully posted items must persist)
  await writeCache(cacheFile, cacheLimit, cache, new Date());

  // record the run outcome in the job summary
  await writeSummary(
    rssFeed,
    dryRun,
    summary.aborted ? "aborted (rate limit)" : "completed",
    summary.posted,
    summary.failed
  );
}

async function writeSummary(
  feedUrl: string,
  dryRun: boolean,
  outcome: string,
  posted: number,
  pending: number
): Promise<void> {
  const summary = core.summary;
  summary.addHeading("MastoFeedBot run");
  summary.addTable([
    [
      { data: "Field", header: true },
      { data: "Value", header: true },
    ],
    ["Feed", feedUrl],
    ["Mode", dryRun ? "dry run" : "live"],
    ["Outcome", outcome],
    ["Posted", String(posted)],
    ["Pending", String(pending)],
  ]);
  summary.write();
}

main();
