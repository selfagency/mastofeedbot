import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
}));
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setFailed: vi.fn(),
  notice: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
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
const sha256Hex = (link: string): string =>
  createHash("sha256").update(link, "utf8").digest("hex");

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdirp = vi.mocked(mkdirp);
const mockedExtract = vi.mocked(extract);
const mockedCreateRestAPIClient = vi.mocked(createRestAPIClient);
const mockedCore = {
  getInput: vi.mocked(core.getInput),
  notice: vi.mocked(core.notice),
  setFailed: vi.mocked(core.setFailed),
};

describe("MastoFeedBot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCache", () => {
    it("should return parsed cache if file exists", async () => {
      const cacheData = ["hash1", "hash2"];
      mockedReadFile.mockResolvedValue(JSON.stringify(cacheData));
      const cache = await getCache("cache.json");
      expect(cache).toEqual(cacheData);
      expect(mockedReadFile).toHaveBeenCalledWith("cache.json", "utf-8");
    });

    it("should return an empty array if file does not exist", async () => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error("File not found"), { code: "ENOENT" })
      );
      const cache = await getCache("cache.json");
      expect(cache).toEqual([]);
      expect(mockedCore.notice).toHaveBeenCalledWith(
        "Cache file not found. Creating new cache file at cache.json."
      );
    });

    it("should fail loudly if the cache file contains invalid JSON", async () => {
      mockedReadFile.mockResolvedValue("not-json");
      const cache = await getCache("cache.json");
      expect(cache).toEqual([]);
      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read cache file")
      );
    });
  });

  describe("writeCache", () => {
    it("should write the cache to a file", async () => {
      const cache = ["hash1", "hash2"];
      await writeCache("/path/to/cache.json", 5, cache);
      expect(mockedMkdirp).toHaveBeenCalledWith("/path/to");
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/path/to/cache.json",
        JSON.stringify(cache)
      );
    });

    it("should slice the cache if it exceeds the limit", async () => {
      const cache = ["hash1", "hash2", "hash3", "hash4", "hash5", "hash6"];
      const expectedCache = ["hash2", "hash3", "hash4", "hash5", "hash6"];
      await writeCache("/path/to/cache.json", 5, cache);
      expect(mockedCore.notice).toHaveBeenCalledWith(
        "Cache limit reached. Removing 1 items."
      );
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/path/to/cache.json",
        JSON.stringify(expectedCache)
      );
    });

    it("should handle errors when writing cache", async () => {
      mockedWriteFile.mockRejectedValue(new Error("Disk full"));
      await writeCache("cache.json", 5, ["hash1"]);
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
      await postItems("endpoint", "token", rss, "public", cache);
      expect(mockCreate).toHaveBeenCalledWith({
        status: "New Post http://example.com/new",
        visibility: "public",
      });
      expect(cache).toContain(sha256Hex("http://example.com/new"));
    });

    it("should handle errors when posting an item", async () => {
      mockCreate.mockRejectedValue(new Error("API error"));
      const rss = [
        { id: "12348", title: "New Post", link: "http://example.com/new" },
      ] as unknown as FeedEntry[];
      const cache: string[] = [];
      await postItems("endpoint", "token", rss, "public", cache);
      expect(mockedCore.setFailed).toHaveBeenCalledWith(
        "Failed to post item: API error"
      );
      expect(cache).not.toContain(sha256Hex("http://example.com/new"));
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
        "cache.json",
        JSON.stringify([sha256Hex(oldLink), sha256Hex(newLink)])
      );
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
  });
});
