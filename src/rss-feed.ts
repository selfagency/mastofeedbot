import { login } from 'masto';
import parser from 'rss-url-parser';

export async function rssFeed(): Promise<void> {
  const { RSS_FEED, API_ENDPOINT, API_TOKEN } = process.env;

  const rss = parser(RSS_FEED);

  const masto = await login({
    url: <string>API_ENDPOINT,
    accessToken: <string>API_TOKEN
  });
}
