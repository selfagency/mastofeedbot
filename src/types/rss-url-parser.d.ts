import { FeedParser } from 'feedparser';

declare module 'rss-url-parser' {
  export default function parser(url: string): FeedParser.Item[];
}
