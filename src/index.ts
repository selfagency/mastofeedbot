import { login, type MastoClient } from 'masto';
import { readFile, writeFile } from 'fs/promises';
import { SHA256Hash } from '@sohailalam2/abu';
import * as core from '@actions/core';
import { type FeedEntry, read } from 'feed-reader';

export async function main(): Promise<void> {
  try {
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

    // get the rss feed
    let rss: FeedEntry[];
    try {
      rss = <FeedEntry[]>(
        await read(<string>rssFeed, undefined, {
          headers: {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            'User-Agent': 'Opera/9.60 (Windows NT 6.0; U; en) Presto/2.1.1',
            Accept: '*/*',
            'Accept-Encoding': 'gzip, deflate',
            Connection: 'keep-alive',
            Cookie:
              '__cf_bm=8kBqUI7KA4i0nKeFCdUT2qSIKEQ_kZzCYKfT2irA1dI-1668578130-0-AUe1xRBXgU6OhrHnHA0IRFVzte5wTSc9R7N4ta/dhX8aK8CajN+yVVxIttCygXbEoZ15AW4h1Ljz0nZqu1654V29vZPkIXXhSXmVj706j/Uc2p0EoAEmXW56xFv9/PGtfw=='
          }
        })
      ).entries;
      core.debug(JSON.stringify(`Pre-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));
    } catch (e) {
      core.setFailed(`Failed to parse RSS feed: ${(<Error>e).message}`);
      return;
    }

    // get the cache
    let cache: string[] = [];
    try {
      cache = JSON.parse(await readFile(<string>cacheFile, 'utf-8'));
      core.debug(`Cache: ${JSON.stringify(cache)}`);
    } catch (e) {
      core.notice(`Cache file not found. Creating new cache file at ${cacheFile}.`);
    }

    // filter out the cached items
    if (cache.length) {
      rss = rss?.filter(item => {
        const hash = <string>new SHA256Hash().hash(<string>item.link);
        return !cache.includes(hash);
      });
    }
    core.debug(JSON.stringify(`Post-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));

    // authenticate with mastodon
    let masto: MastoClient;
    try {
      masto = await login({
        url: <string>apiEndpoint,
        accessToken: <string>apiToken
      });
    } catch (e) {
      core.setFailed(`Failed to authenticate with Mastodon: ${(<Error>e).message}`);
      return;
    }

    // post the new items
    for (const item of rss) {
      const hash = <string>new SHA256Hash().hash(<string>item.link);
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
