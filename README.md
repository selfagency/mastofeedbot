# Mastofeedbot

Mastofeedbot is a bot that posts RSS feeds to Mastodon via GitHub Actions.

## Usage

```yaml
name: FeedBot
on:
  schedule:
    - cron: '*/5 * * * *'
jobs:
  rss-to-mastodon:
    runs-on: ubuntu-latest
    steps:
      - name: Generate cache key
        uses: actions/github-script@v6
        id: generate-key
        with:
          script: |
            core.setOutput('cache-key', new Date().valueOf())
      - name: Retrieve cache
        uses: actions/cache@v2
        with:
          path: ${{ github.workspace }}/mastofeedbot
          key: feed-cache-${{ steps.generate-key.outputs.cache-key }}
          restore-keys: feed-cache-
      - name: GitHub
        uses: 'selfagency/slackfeedbot@main'
        with:
          rss-feed: https://www.githubstatus.com/history.rss
          api-endpoint: https://mastodon.social
          api-token: ${{ secrets.MASTODON_ACCESS_TOKEN }}
          cache-file: ${{ github.workspace }}/mastofeedbot/cache.json
```

