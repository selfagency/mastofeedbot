import { login, StatusVisibility, type MastoClient } from 'masto';
import { readFile, writeFile } from 'fs/promises';
import { SHA256Hash } from '@sohailalam2/abu';
import * as core from '@actions/core';
import mkdirp from 'mkdirp';
import { type FeedEntry, read } from '@extractus/feed-extractor';

async function writeCache(cacheFile: string, cacheLimit: number, cache: string[]): Promise<void> {
  try {
    // limit the cache
    if (cache.length > cacheLimit) {
      core.notice(`Cache limit reached. Removing ${cache.length - cacheLimit} items.`);
      cache = cache.slice(cache.length - cacheLimit);
    }

    // make sure the cache directory exists
    await mkdirp(cacheFile.substring(0, cacheFile.lastIndexOf('/')));

    // write the cache
    await writeFile(cacheFile, JSON.stringify(cache));
  } catch (e) {
    core.setFailed(`Failed to write cache file: ${(<Error>e).message}`);
  }
}

async function postItems(apiEndpoint: string, apiToken: string, rss: FeedEntry[], visibility: StatusVisibility, cache: string[]) {
  // authenticate with mastodon
  let masto: MastoClient;
  try {
    masto = await login({
      url: apiEndpoint,
      accessToken: apiToken
    });
  } catch (e) {
    core.setFailed(`Failed to authenticate with Mastodon: ${(<Error>e).message}`);
    return;
  }

  // post the new items
  for (const item of rss) {
    try {
      const hash = <string>new SHA256Hash().hash(<string>item.link);
      core.debug(`Posting ${item.title} with hash ${hash}`);

      // post the item
      const res = await masto.statuses.create({
        status: `${item.title} ${item.link}`,
        visibility,
      }, hash);
      core.debug(`Response:\n\n${JSON.stringify(res, null, 2)}`);

      // add the item to the cache
      cache.push(hash);
    } catch (e) {
      core.setFailed(`Failed to post item: ${(<Error>e).message}`);
    }
  }
}

async function filterCachedItems(rss: FeedEntry[], cache: string[]): Promise<FeedEntry[]> {
  if (cache.length) {
    rss = rss?.filter(item => {
      const hash = <string>new SHA256Hash().hash(<string>item.link);
      return !cache.includes(hash);
    });
  }
  core.debug(JSON.stringify(`Post-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));
  return rss;
}

async function getRss(rssFeed: string): Promise<FeedEntry[] | void> {
  let rss: FeedEntry[];
  try {
    rss = <FeedEntry[]>(await read(rssFeed)).entries;
    core.debug(JSON.stringify(`Pre-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));
    return rss;
  } catch (e) {
    core.setFailed(`Failed to parse RSS feed: ${(<Error>e).message}`);
  }
}

async function getCache(cacheFile: string): Promise<string[]> {
  let cache: string[] = [];
  try {
    cache = JSON.parse(await readFile(cacheFile, 'utf-8'));
    core.debug(`Cache: ${JSON.stringify(cache)}`);
    return cache;
  } catch (e) {
    core.notice(`Cache file not found. Creating new cache file at ${cacheFile}.`);
    return cache;
  }
}

export async function main(): Promise<void> {
  // get variables from environment
  const rssFeed = core.getInput('rss-feed');
  core.debug(`rssFeed: ${rssFeed}`);
  const apiEndpoint = core.getInput('api-endpoint');
  core.debug(`apiEndpoint: ${apiEndpoint}`);
  const apiToken = core.getInput('api-token');
  core.debug(`apiToken: ${apiToken}`);
  const cacheFile = core.getInput('cache-file');
  core.debug(`cacheFile: ${cacheFile}`);
  const cacheLimit = parseInt(core.getInput('cache-limit'), 10);
  core.debug(`cacheLimit: ${cacheLimit}`);
  const statusVisibility: StatusVisibility = <StatusVisibility>core.getInput('status-visibility', { trimWhitespace: true });
  core.debug(`statusVisibility: ${statusVisibility}`);

  // get the rss feed
  let rss = await getRss(rssFeed);

  // get the cache
  const cache = await getCache(cacheFile);

  // filter out the cached items
  rss = await filterCachedItems(<FeedEntry[]>rss, cache);

  // post the new items
  await postItems(apiEndpoint, apiToken, <FeedEntry[]>rss, statusVisibility, cache);

  // write the cache
  await writeCache(cacheFile, cacheLimit, cache);
}

(async () => await main())();
