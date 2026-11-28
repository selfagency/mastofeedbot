import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import * as core from "@actions/core";
import type { FeedEntry } from "@extractus/feed-extractor";
import { extract } from "@extractus/feed-extractor";
import { createRestAPIClient } from "masto";
import { mkdirp } from "mkdirp";

const FEED_FETCH_OPTIONS = {
  getExtraEntryFields: (raw: Record<string, unknown>) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: malformed feeds may omit the enclosure object at runtime
    const enclosure = raw?.enclosure as
      | { url?: string; type?: string }
      | undefined;
    return {
      enclosureUrl: enclosure?.url ?? "",
      enclosureType: enclosure?.type ?? "",
    };
  },
};
const FEED_FETCHER = (url: string): Promise<Response> =>
  fetch(url, { signal: AbortSignal.timeout(60_000) });

function isTrue(value: unknown): boolean {
  return value === true || String(value) === "true";
}

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

export interface PostItemOptions {
  attachEnclosures: boolean;
  format: string;
  language?: string;
  sensitive: boolean;
  spoilerText?: string;
}

export interface PostSummary {
  aborted: boolean;
  failed: number;
  posted: number;
}

export function statusText(
  item: { title?: string; link?: string; description?: string },
  format: string
): string {
  const text = format
    .replaceAll("{{title}}", item.title ?? "")
    .replaceAll("{{link}}", item.link ?? "")
    .replaceAll("{{description}}", item.description ?? "")
    .trim();
  if (text.length <= 497) {
    return text;
  }
  return `${text.slice(0, 497)}...`;
}

export async function postItems(
  apiEndpoint: string,
  apiToken: string,
  rss: FeedEntry[],
  visibility: "public" | "unlisted" | "private" | "direct",
  cache: string[],
  options: PostItemOptions
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
      const status = statusText(item, options.format);

      // attach the first image enclosure, if any (best effort: posting continues without media)
      // biome-ignore lint/performance/noAwaitInLoops: sequential posting preserves feed order and respects API rate limits
      const mediaId = await attachEnclosureImage(masto, item, options);
      const mediaIds = mediaId ? [mediaId] : [];

      // post the item
      const res = await masto.v1.statuses.create({
        status,
        visibility,
        ...(options.language ? { language: options.language } : {}),
        ...(options.sensitive ? { sensitive: true } : {}),
        ...(options.spoilerText ? { spoilerText: options.spoilerText } : {}),
        ...(mediaIds.length ? { mediaIds } : {}),
      });
      core.debug(`Response:\n\n${JSON.stringify(res, null, 2)}`);

      // add the item to the cache
      cache.push(hash);
      posted += 1;
    } catch (e) {
      failed += 1;
      lastError = (<Error>e).message;
      const { statusCode } = e as { statusCode?: number };
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

async function attachEnclosureImage(
  masto: ReturnType<typeof createRestAPIClient>,
  item: FeedEntry,
  options: PostItemOptions
): Promise<string | undefined> {
  const enclosureUrl = String(
    (item as { enclosureUrl?: string }).enclosureUrl ?? ""
  );
  const enclosureType = String(
    (item as { enclosureType?: string }).enclosureType ?? ""
  );
  if (
    !(
      options.attachEnclosures &&
      enclosureUrl &&
      enclosureType.startsWith("image/")
    )
  ) {
    return undefined;
  }
  try {
    const response = await fetch(enclosureUrl, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) {
      throw new Error("enclosure exceeds 8 MB");
    }
    const blob = new Blob([bytes], { type: enclosureType });
    const attachment = await masto.v1.media.create({
      file: blob,
      description: item.title ?? undefined,
    });
    return attachment.id;
  } catch (mediaError) {
    core.warning(
      `Failed to attach enclosure ${enclosureUrl}: ${(<Error>mediaError).message}`
    );
    return undefined;
  }
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
): Promise<{ entries: FeedEntry[]; language?: string } | undefined> {
  try {
    const feed = await extract(rssFeed, FEED_FETCH_OPTIONS, FEED_FETCHER);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: malformed feeds may omit entries at runtime
    const rss = feed?.entries ?? [];
    core.debug(
      JSON.stringify(
        `Pre-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`
      )
    );
    // biome-ignore lint/suspicious/noUnnecessaryConditions: malformed feeds may omit the language at runtime
    return { entries: rss, language: feed?.language };
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
      cache:
        // biome-ignore lint/suspicious/noUnnecessaryConditions: malformed caches may lack the seen array at runtime
        stored.seen ?? [],
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
  const feedData = await getRss(rssFeed);
  let rss = feedData?.entries;

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
  const dryRun = isTrue(dryRunInput);
  const languageInput = core.getInput("language", { trimWhitespace: true });
  const feedLanguage = feedData?.language ?? "";
  const language = String(feedLanguage || languageInput || "")
    .split("-")[0]
    .toLowerCase();
  const sensitiveInput = core.getBooleanInput("sensitive");
  const spoilerText = core
    .getInput("spoiler-text", { trimWhitespace: true })
    .trim();
  const statusFormat =
    core.getInput("status-format", { trimWhitespace: true }).trim() ||
    "{{title}} {{link}}";
  const attachEnclosures = core.getBooleanInput("attach-enclosures");
  const postOptions: PostItemOptions = {
    format: statusFormat,
    language: language || undefined,
    sensitive:
      sensitiveInput === true ||
      (sensitiveInput as unknown) === "true" ||
      spoilerText !== "",
    spoilerText: spoilerText || undefined,
    attachEnclosures:
      attachEnclosures === true || (attachEnclosures as unknown) === "true",
  };
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
    writeSummary(rssFeed, dryRun, "baseline", 0, (<FeedEntry[]>rss).length);
    return;
  }

  // nothing older than the last run may be posted, regardless of cache size
  rss = filterCachedItems(<FeedEntry[]>rss, cache, lastRun);

  // if there are no new items, we're done
  if (rss.length === 0) {
    core.notice("No new items to post.");
    writeSummary(rssFeed, dryRun, "clean", 0, 0);
    return;
  }

  // dry run: report what would be posted and touch nothing
  if (dryRun) {
    core.notice(
      `Dry run: ${(<FeedEntry[]>rss).length} item(s) would be posted.`
    );
    writeSummary(rssFeed, true, "dry-run", 0, (<FeedEntry[]>rss).length);
    return;
  }

  // post the new items
  const summary = await postItems(
    apiEndpoint,
    apiToken,
    <FeedEntry[]>rss,
    statusVisibility,
    cache,
    postOptions
  );

  // write the cache (even on abort: successfully posted items must persist)
  await writeCache(cacheFile, cacheLimit, cache, new Date());

  // record the run outcome in the job summary
  writeSummary(
    rssFeed,
    dryRun,
    summary.aborted ? "aborted (rate limit)" : "completed",
    summary.posted,
    summary.failed
  );
}

function writeSummary(
  feedUrl: string,
  dryRun: boolean,
  outcome: string,
  posted: number,
  pending: number
): void {
  // biome-ignore lint/style/useDestructuring: @actions/core Summary methods are class-bound; destructuring detaches them from `this` in the packaged action
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
