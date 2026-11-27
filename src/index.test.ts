import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import * as core from "@actions/core";
import type { FeedData, FeedEntry } from "@extractus/feed-extractor";
import { extract } from "@extractus/feed-extractor";
import { createRestAPIClient } from "masto";
import { mkdirp } from "mkdirp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterCachedItems,
  getCache,
  getRss,
  main,
  postItems,
  writeCache,
} from "./index";

// Mock all the external dependencies
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setFailed: vi.fn(),
  notice: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  summary: {
    addHeading: vi.fn(),
    addTable: vi.fn(),
    addRaw: vi.fn(),
    addBreak: vi.fn(),
    write: vi.fn(),
  },
}));
vi.mock("mkdirp", () => ({
  mkdirp: vi.fn(),
}));
vi.mock("masto", () => ({
  createRestAPIClient: vi.fn(),
}));
vi.mock("@extractus/feed-extractor", () => ({
  extract: vi.fn(),
}));

// Real hashing: createHash is pure and deterministic, mirroring src/index.ts
const sha256Hex = (link: string | undefined): string =>
  createHash("sha256").update(String(link), "utf8").digest("hex");

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedRename = vi.mocked(rename);
const mockedMkdirp = vi.mocked(mkdirp);
const mockedExtract = vi.mocked(extract);
const mockedCreateRestAPIClient = vi.mocked(createRestAPIClient);
type SummaryStub = {
  addHeading: ReturnType<typeof vi.fn>;
  addTable: ReturnType<typeof vi.fn>;
  addRaw: ReturnType<typeof vi.fn>;
  addBreak: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};
const mockedCore = {
  getInput: vi.mocked(core.getInput),
  getBooleanInput: vi.mocked(core.getBooleanInput),
  debug: vi.mocked(core.debug),
  notice: vi.mocked(core.notice),
  setFailed: vi.mocked(core.setFailed),
  summary: core.summary as unknown as SummaryStub,
};

describe("MastoFeedBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("filterCachedItems time window", () => {
    it("drops entries published before the last run even when uncached", () => {
      const rss = [
        {
          id: "old",
          title: "Old But Uncached",
          link: "http://example.com/old-but-uncached",
          published: "2020-01-01T00:00:00Z",
        },
        {
          id: "fresh",
          title: "Fresh",
          link: "http://example.com/fresh",
          published: "2026-11-27T06:00:00Z",
        },
      ] as unknown as FeedEntry[];
      const filtered = filterCachedItems(
        rss,
        ["some-other-hash"],
        new Date("2026-11-27T00:00:00Z")
      );
      const titles = filtered.map((item) => item.title);
      expect(titles).toEqual(["Fresh"]);
    });

    it("keeps entries without a published date and relies on the cache", () => {
      const rss = [
        { id: "undated", title: "Undated", link: "http://example.com/undated" },
      ] as unknown as FeedEntry[];
      const filtered = filterCachedItems(
        rss,
        [],
        new Date("2026-11-27T00:00:00Z")
      );
      expect(filtered).toHaveLength(1);
    });
  });

  describe("getCache", () => {
    it("should return existed true and parsed cache if file exists", async () => {
      const cacheData = ["hash1", "hash2"];
      mockedReadFile.mockResolvedValue(JSON.stringify(cacheData));
      const { cache, existed, failed } = await getCache("cache.json");
      expect(cache).toEqual(cacheData);
      expect(existed).toBe(true);
      expect(failed).toBe(false);
      expect(mockedReadFile).toHaveBeenCalledWith("cache.json", "utf-8");
    });

    it("should return existed false if file does not exist", async () => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error("File not found"), { code: "ENOENT" })
      );
      const { cache, existed, failed } = await getCache("cache.json");
      expect(existed).toBe(false);
      expect(failed).toBe(false);
      expect(mockedCore.notice).toHaveBeenCalledWith(
        "Cache file not found. Creating new cache file at cache.json."
      );
    });

    it("migrates legacy array caches and assigns a fresh lastRun", async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify(["legacy-hash"]));
      const before = Date.now();
      const { cache, lastRun, existed } = await getCache("cache.json");
      expect(cache).toEqual(["legacy-hash"]);
      expect(existed).toBe(true);
      expect(
        new Date(await Promise.resolve(lastRun)).getTime()
      ).toBeGreaterThanOrEqual(before);
    });

    it("parses v2 cache files with lastRun and seen", async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ lastRun: "2026-11-01T00:00:00Z", seen: ["h1"] })
      );
      const { cache, lastRun } = await getCache("cache.json");
      expect(cache).toEqual(["h1"]);
      expect(new Date(lastRun).toISOString()).toEqual(
        new Date("2026-11-01T00:00:00Z").toISOString()
      );
    });

    it("should fail loudly if the cache file contains invalid JSON", async () => {
      mockedReadFile.mockResolvedValue("not-json");
      const { cache, existed, failed } = await getCache("cache.json");
      expect(cache).toEqual([]);
      expect(existed).toBe(false);
      expect(failed).toBe(true);
      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read cache file")
      );
    });
  });

  describe("writeCache", () => {
    it("should write the cache to a file atomically", async () => {
      const lastRun = new Date("2026-01-02T00:00:00.000Z");
      const cache = ["hash1", "hash2"];
      await writeCache("/path/to/cache.json", 5, cache, lastRun);
      expect(mockedMkdirp).toHaveBeenCalledWith("/path/to");
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/path/to/cache.json.tmp",
        JSON.stringify({ lastRun: "2026-01-02T00:00:00.000Z", seen: cache })
      );
      expect(mockedRename).toHaveBeenCalledWith(
        "/path/to/cache.json.tmp",
        "/path/to/cache.json"
      );
    });

    it("should slice the cache if it exceeds the limit", async () => {
      const cache = ["hash1", "hash2", "hash3", "hash4", "hash5", "hash6"];
      const expectedCache = ["hash2", "hash3", "hash4", "hash5", "hash6"];
      await writeCache(
        "/path/to/cache.json",
        5,
        cache,
        new Date("2026-01-02T00:00:00.000Z")
      );
      expect(mockedCore.notice).toHaveBeenCalledWith(
        "Cache limit reached. Removing 1 items."
      );
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/path/to/cache.json.tmp",
        JSON.stringify({
          lastRun: "2026-01-02T00:00:00.000Z",
          seen: expectedCache,
        })
      );
    });

    it("should handle errors when writing cache", async () => {
      mockedWriteFile.mockRejectedValueOnce(new Error("Disk full"));
      await writeCache(
        "cache.json",
        5,
        ["hash1"],
        new Date("2026-01-02T00:00:00.000Z")
      );
      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "Failed to write cache file: Disk full"
      );
    });
  });

  describe("getRss", () => {
    it("should return rss entries on successful fetch", async () => {
      const feed = {
        entries: [
          { id: "12345", title: "Test Post", link: "http://example.com/post1" },
        ],
      };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);
      const rss = await getRss("http://example.com/rss");
      expect(rss).toEqual(feed.entries);
    });

    it("should return empty array if entries are null", async () => {
      const feed = { entries: null };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);
      const rss = await getRss("http://example.com/rss");
      expect(rss).toEqual([]);
    });

    it("should handle errors when fetching rss feed and return undefined", async () => {
      mockedExtract.mockRejectedValue(new Error("Network error"));
      const rss = await getRss("http://example.com/rss");
      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "Failed to parse RSS feed: Network error"
      );
      expect(rss).toBeUndefined();
    });
  });

  describe("filterCachedItems", () => {
    const rssItems = [
      { id: "12345", title: "Post 1", link: "http://example.com/1" },
      { id: "12346", title: "Post 2", link: "http://example.com/2" },
      { id: "12347", title: "Post 3", link: "http://example.com/3" },
    ] as unknown as FeedEntry[];

    it("should filter out items that are in the cache", async () => {
      const cache = [
        sha256Hex("http://example.com/1"),
        sha256Hex("http://example.com/3"),
      ];
      const filtered = await filterCachedItems(rssItems, cache);
      const expected = [
        { id: "12346", title: "Post 2", link: "http://example.com/2" },
      ];
      expect(filtered).toEqual(expected);
    });

    it("should return all items if cache is empty", async () => {
      const filtered = await filterCachedItems(rssItems, []);
      expect(filtered).toEqual(rssItems);
    });
  });

  describe("postItems", () => {
    const mockCreate = vi.fn();
    beforeEach(() => {
      mockCreate.mockClear();
      mockedCreateRestAPIClient.mockReturnValue({
        v1: {
          statuses: {
            create: mockCreate.mockResolvedValue({ id: "123" }),
          },
        },
      } as unknown as ReturnType<typeof createRestAPIClient>);
    });

    it("should post new items to mastodon", async () => {
      const rss = [
        { id: "12348", title: "New Post", link: "http://example.com/new" },
      ] as unknown as FeedEntry[];
      const cache: string[] = [];
      const summary = await postItems(
        "endpoint",
        "token",
        rss,
        "public",
        cache
      );
      expect(mockCreate).toHaveBeenCalledWith({
        status: "New Post http://example.com/new",
        visibility: "public",
      });
      expect(cache).toContain(sha256Hex("http://example.com/new"));
      expect(summary.posted).toBe(1);
      expect(summary.aborted).toBe(false);
    });

    it("should post bare link for titleless entries", async () => {
      const rss = [
        { id: "12349", link: "http://example.com/no-title" },
      ] as unknown as FeedEntry[];
      const cache: string[] = [];
      await postItems("endpoint", "token", rss, "public", cache);
      expect(mockCreate).toHaveBeenCalledWith({
        status: "http://example.com/no-title",
        visibility: "public",
      });
    });

    it("should abort on mastodon rate limiting and leave remaining items uncached", async () => {
      const rss = [
        { id: "1", title: "First", link: "http://example.com/1" },
        { id: "2", title: "Second", link: "http://example.com/2" },
        { id: "3", title: "Third", link: "http://example.com/3" },
      ] as unknown as FeedEntry[];
      mockCreate
        .mockResolvedValueOnce({ id: "1" })
        .mockRejectedValueOnce(
          Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 })
        );
      const cache: string[] = [];
      const summary = await postItems(
        "endpoint",
        "token",
        rss,
        "public",
        cache
      );
      expect(summary.aborted).toBe(true);
      expect(summary.posted).toBe(1);
      expect(cache).toEqual([sha256Hex("http://example.com/1")]);
      // the third item was never attempted
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("should handle errors when posting an item", async () => {
      mockCreate.mockRejectedValue(new Error("API error"));
      const rss = [
        { id: "12348", title: "New Post", link: "http://example.com/new" },
      ] as unknown as FeedEntry[];
      const cache: string[] = [];
      const summary = await postItems(
        "endpoint",
        "token",
        rss,
        "public",
        cache
      );
      expect(summary.failed).toBe(1);
      expect(summary.posted).toBe(0);
      expect(cache).not.toContain(sha256Hex("http://example.com/new"));
      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "Failed to post 1 of 1 items. Last error: API error"
      );
    });
  });

  describe("main", () => {
    let create: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Mock inputs
      mockedCore.getInput.mockImplementation((name) => {
        const inputs: { [key: string]: string } = {
          "rss-feed": "http://example.com/rss",
          "api-endpoint": "https://mastodon.social",
          "api-token": "test-token",
          "cache-file": "cache.json",
          "cache-limit": "100",
          "status-visibility": "public",
        };
        return inputs[name];
      });

      create = vi.fn().mockResolvedValue({ id: "123" });
      mockedCreateRestAPIClient.mockReturnValue({
        v1: {
          statuses: {
            create,
          },
        },
      } as unknown as ReturnType<typeof createRestAPIClient>);
    });

    it("should run the main process", async () => {
      const oldLink = "http://example.com/old";
      const newLink = "http://example.com/new";
      mockedReadFile.mockResolvedValue(JSON.stringify([sha256Hex(oldLink)]));
      const feed = {
        entries: [
          { title: "Old Post", link: oldLink },
          { title: "New Post", link: newLink },
        ],
      };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);

      await main();

      expect(mockedCore.getInput).toHaveBeenCalledWith("rss-feed");
      expect(mockedExtract).toHaveBeenCalledWith("http://example.com/rss");
      expect(mockedReadFile).toHaveBeenCalledWith("cache.json", "utf-8");
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({
        status: "New Post http://example.com/new",
        visibility: "public",
      });
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "cache.json.tmp",
        expect.stringContaining('"seen"')
      );
      expect(mockedRename).toHaveBeenCalledWith("cache.json.tmp", "cache.json");
    });

    it("should exit early if rss feed is empty", async () => {
      mockedReadFile.mockResolvedValue("[]");
      const feed = { entries: [] };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);

      await main();

      expect(mockedCore.notice).toHaveBeenCalledWith("No new items to post.");
      expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it("should exit early if rss feed fails", async () => {
      mockedExtract.mockRejectedValue(new Error("Network error"));

      await main();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "Failed to parse RSS feed: Network error"
      );
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it("should record baseline without posting on first run", async () => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error("File not found"), { code: "ENOENT" })
      );
      const feed = {
        entries: [
          { title: "Old Post", link: "http://example.com/old" },
          { title: "New Post", link: "http://example.com/new" },
        ],
      } as unknown as FeedData;
      mockedExtract.mockResolvedValue(feed);

      await main();

      expect(mockedCore.notice).toHaveBeenCalledWith(
        "First run: feed baseline recorded. No items posted."
      );
      expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "cache.json.tmp",
        expect.stringContaining(
          `"seen":["${sha256Hex("http://example.com/old")}","${sha256Hex("http://example.com/new")}"]`
        )
      );
      expect(mockedRename).toHaveBeenCalledWith("cache.json.tmp", "cache.json");
    });

    it("should post nothing and never write cache when cache is corrupt", async () => {
      mockedReadFile.mockResolvedValue("not-json");
      const feed = {
        entries: [{ title: "New Post", link: "http://example.com/new" }],
      } as unknown as FeedData;
      mockedExtract.mockResolvedValue(feed);

      await main();

      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read cache file")
      );
      expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it("should not post if all items are cached", async () => {
      const oldLink = "http://example.com/old";
      const newLink = "http://example.com/new";
      mockedReadFile.mockResolvedValue(
        JSON.stringify([sha256Hex(oldLink), sha256Hex(newLink)])
      );
      const feed = {
        entries: [
          { title: "Old Post", link: oldLink },
          { title: "New Post", link: newLink },
        ],
      };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);

      await main();

      expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it("should never log the access token", async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify([sha256Hex("http://example.com/old")])
      );
      const feed = {
        entries: [{ title: "New Post", link: "http://example.com/new" }],
      };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);

      await main();

      for (const call of mockedCore.debug.mock.calls) {
        expect(String(call[0])).not.toContain("test-token");
      }
    });

    it("should write a job summary on a normal run", async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify([sha256Hex("http://example.com/old")])
      );
      const feed = {
        entries: [{ title: "New Post", link: "http://example.com/new" }],
      };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);

      await main();

      expect(mockedCore.summary.addTable).toHaveBeenCalledTimes(1);
      expect(mockedCore.summary.write).toHaveBeenCalledTimes(1);
    });

    it("should skip posting and cache writes in dry-run mode", async () => {
      mockedCore.getBooleanInput.mockImplementation(
        (name) => String(name === "dry-run").toLowerCase() as unknown as boolean
      );
      mockedReadFile.mockResolvedValue(
        JSON.stringify([sha256Hex("http://example.com/old")])
      );
      const feed = {
        entries: [{ title: "New Post", link: "http://example.com/new" }],
      };
      mockedExtract.mockResolvedValue(feed as unknown as FeedData);

      await main();

      expect(mockedCore.notice).toHaveBeenCalledWith(
        expect.stringContaining("Dry run: 1 item(s) would be posted")
      );
      expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(mockedRename).not.toHaveBeenCalled();
    });
  });
});
