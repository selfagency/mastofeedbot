import { login } from 'masto';
import parser from 'rss-url-parser';
import { readFile, writeFile } from 'fs/promises';
import { SHA256Hash } from '@sohailalam2/abu';
import * as core from '@actions/core';

export async function main(): Promise<void> {
  try {
    // get variables from environment
    const rssFeed = core.getInput('rss-feed');
    const apiEndpoint = core.getInput('api-endpoint');
    const apiToken = core.getInput('api-token');
    const cacheFile = core.getInput('cache-file');
    const cacheLimit = parseInt(core.getInput('cache-limit'), 10);

    core.debug(`rssFeed: ${rssFeed}`);
    core.debug(`apiEndpoint: ${apiEndpoint}`);
    core.debug(`apiToken: ${apiToken}`);
    core.debug(`cacheFile: ${cacheFile}`);
    core.debug(`cacheLimit: ${cacheLimit}`);

    // get the rss feed
    let rss = await parser(<string>rssFeed);

    // get the cache
    let cache: string[] = [];
    try {
      cache = JSON.parse(await readFile(<string>cacheFile, 'utf-8'));
      core.debug(`Cache: ${JSON.stringify(cache)}`);
    } catch (e) {
      core.notice(`Cache file not found. Creating new cache file at ${cacheFile}.`);
    }

    // filter out the cached items
    core.debug(JSON.stringify(`Pre-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));
    if (cache.length) {
      rss = rss?.filter(item => {
        const hash = <string>new SHA256Hash().hash(item.link);
        return !cache.includes(hash);
      });
    }
    core.debug(JSON.stringify(`Post-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));

    // authenticate with mastodon
    const masto = await login({
      url: <string>apiEndpoint,
      accessToken: <string>apiToken
    });

    // post the new items
    for (const item of rss) {
      const hash = <string>new SHA256Hash().hash(item.link);
      core.debug(`Posting ${item.title} with hash ${hash}`);

      // post the item
      const res = await masto.statuses.create({
        status: `${item.title} ${item.link}`,
        visibility: 'public'
      });
      core.debug(`Response:\n\n${JSON.stringify(res, null, 2)}`);

      // add the item to the cache
      cache.push(hash);
    }

    // limit the cache
    if (cache.length > cacheLimit) {
      core.notice(`Cache limit reached. Removing ${cache.length - cacheLimit} items.`);
      cache = cache.slice(cache.length - cacheLimit);
    }

    // write the cache
    await writeFile(<string>cacheFile, JSON.stringify(cache));
  } catch (error) {
    core.setFailed((<Error>error).message);
  }
}

(async () => await main())();
