# Mastofeedbot

Mastofeedbot is a bot that posts RSS feeds to Mastodon via GitHub Actions.

## Usage

1. Go to `https://${YOUR_INSTANCE}/settings/applications/new` and add a new application.

  - Name it whatever you want.
  - The redirect URI is not important, so you can use `urn:ietf:wg:oauth:2.0:oob`.
  - The only permission required is `write:statuses`.
  - Save it, click on the application link, and grab the access token.

2. Create a new GitHub repository.
3. Go to your repository settings at `https://github.com/${YOUR_REPO}/settings/secrets/actions/new`, and add a new
   secret with the value of the access token.
4. Add a file named `.github/workflows/mastofeedbot.yml` with the following content:

```yaml
name: FeedBot
on:
  schedule:
    # This will run every five minutes. Alter it using https://crontab.guru/.
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
        uses: actions/cache@v3
        with:
          path: ${{ github.workspace }}/mastofeedbot
          key: feed-cache-${{ steps.generate-key.outputs.cache-key }}
          restore-keys: feed-cache-
      - name: GitHub
        uses: 'selfagency/mastofeedbot@v1'
        with:
          # This is the RSS feed you want to publish
          rss-feed: https://www.githubstatus.com/history.rss
          # Visibility of the posted status (public | unlisted | private | direct)
          status-visibility: public
          # This is your instance address
          api-endpoint: https://mastodon.social
          # This is the secret you created earlier
          api-token: ${{ secrets.MASTODON_ACCESS_TOKEN }}
          # This is a path to the cache file, using the above cache path
          cache-file: ${{ github.workspace }}/mastofeedbot/cache.json
```

5. Commit and publish your changes.
