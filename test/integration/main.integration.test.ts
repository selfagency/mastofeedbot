import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { extract } from "@extractus/feed-extractor";
import { createRestAPIClient } from "masto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/index";

// Integration suite: real filesystem cache + real SHA256 hashing; network and
// Mastodon are stubbed at their boundaries (extract / createRestAPIClient).
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setFailed: vi.fn(),
  notice: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("masto", () => ({
  createRestAPIClient: vi.fn(),
}));
vi.mock("@extractus/feed-extractor", () => ({
  extract: vi.fn(),
}));

const mockedExtract = vi.mocked(extract);
const mockedCreateRestAPIClient = vi.mocked(createRestAPIClient);
const mockedCore = {
  getInput: vi.mocked(core.getInput),
  notice: vi.mocked(core.notice),
  setFailed: vi.mocked(core.setFailed),
};

const feedUrl = "https://feed.test/rss.xml";
const oldLink = "http://example.com/old";
const newLink = "http://example.com/new";

function hashFor(link: string): string {
  return createHash("sha256").update(link, "utf8").digest("hex");
}

describe("main integration", () => {
  let tempDir: string;
  let cacheFile: string;
  let inputs: Map<string, string>;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mastofeedbot-"));
    cacheFile = join(tempDir, "cache.json");
    inputs = new Map<string, string>([
      ["rss-feed", feedUrl],
      ["api-endpoint", "https://mastodon.test"],
      ["api-token", "test-token"],
      ["cache-file", cacheFile],
      ["cache-limit", "100"],
      ["status-visibility", "public"],
    ]);
    mockedCore.getInput.mockImplementation((name) => inputs.get(name) ?? "");

    create = vi.fn().mockResolvedValue({ id: "123" });
    mockedCreateRestAPIClient.mockReturnValue({
      v1: {
        statuses: {
          create,
        },
      },
    } as unknown as ReturnType<typeof createRestAPIClient>);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("posts only uncached entries and persists the updated cache", async () => {
    const [oldHash, newHash] = await Promise.all([
      hashFor(oldLink),
      hashFor(newLink),
    ]);
    await writeFileHelper(cacheFile, JSON.stringify([oldHash]));
    mockedExtract.mockResolvedValue({
      entries: [
        { title: "Old Post", link: oldLink },
        { title: "New Post", link: newLink },
      ],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      status: `New Post ${newLink}`,
      visibility: "public",
    });
    expect(mockedCreateRestAPIClient).toHaveBeenCalledWith({
      accessToken: "test-token",
      url: "https://mastodon.test",
    });
    const persisted = JSON.parse(
      await readFile(cacheFile, "utf-8")
    ) as string[];
    expect(persisted).toEqual([oldHash, newHash]);
  });

  it("does not post when every entry is already cached", async () => {
    const [oldHash, newHash] = await Promise.all([
      hashFor(oldLink),
      hashFor(newLink),
    ]);
    await writeFileHelper(cacheFile, JSON.stringify([oldHash, newHash]));
    mockedExtract.mockResolvedValue({
      entries: [
        { title: "Old Post", link: oldLink },
        { title: "New Post", link: newLink },
      ],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    expect(mockedCore.notice).toHaveBeenCalledTimes(1);
    expect(mockedCore.notice).toHaveBeenCalledWith("No new items to post.");
    expect(create).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      await readFile(cacheFile, "utf-8")
    ) as string[];
    expect(persisted).toEqual([oldHash, newHash]);
  });

  it("records baseline without posting on a cold cache", async () => {
    mockedExtract.mockResolvedValue({
      entries: [
        { title: "Old Post", link: oldLink },
        { title: "New Post", link: newLink },
      ],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    expect(mockedCore.notice).toHaveBeenCalledWith(
      "First run: feed baseline recorded. No items posted."
    );
    expect(create).not.toHaveBeenCalled();
    const persisted = JSON.parse(
      await readFile(cacheFile, "utf-8")
    ) as string[];
    expect(persisted).toEqual([hashFor(oldLink), hashFor(newLink)]);
  });

  it("fails loudly without posting when the cache file is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cacheFile, "not-json");
    mockedExtract.mockResolvedValue({
      entries: [{ title: "New Post", link: newLink }],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    expect(mockedCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read cache file")
    );
    expect(create).not.toHaveBeenCalled();
    const persisted = await readFile(cacheFile, "utf-8");
    expect(persisted).toEqual("not-json");
  });

  it("does not write a cache file when the feed is empty", async () => {
    mockedExtract.mockResolvedValue({
      entries: [],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    expect(mockedCore.notice).toHaveBeenCalledWith("No new items to post.");
    expect(create).not.toHaveBeenCalled();
    let exists = true;
    try {
      await stat(cacheFile);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("fails gracefully when the feed cannot be fetched", async () => {
    mockedExtract.mockRejectedValue(new Error("Network error"));

    await main();

    expect(mockedCore.setFailed).toHaveBeenCalledWith(
      "Failed to parse RSS feed: Network error"
    );
    expect(mockedCreateRestAPIClient).not.toHaveBeenCalled();
  });

  it("enforces the cache limit when persisting", async () => {
    const [firstHash, oldHash, newHash] = await Promise.all([
      hashFor("http://example.com/first"),
      hashFor(oldLink),
      hashFor(newLink),
    ]);
    inputs.set("cache-limit", "1");
    await writeFileHelper(cacheFile, JSON.stringify([firstHash, oldHash]));
    mockedExtract.mockResolvedValue({
      entries: [{ title: "New Post", link: newLink }],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    const persisted = JSON.parse(
      await readFile(cacheFile, "utf-8")
    ) as string[];
    expect(persisted).toEqual([newHash]);
  });

  it("skips caching for entries whose post fails", async () => {
    const oldHash = await hashFor(oldLink);
    const newHash = await hashFor(newLink);
    await writeFileHelper(cacheFile, JSON.stringify([oldHash]));
    create.mockRejectedValue(new Error("API error"));
    mockedExtract.mockResolvedValue({
      entries: [{ title: "New Post", link: newLink }],
    } as unknown as Awaited<ReturnType<typeof extract>>);

    await main();

    expect(mockedCore.setFailed).toHaveBeenCalledWith(
      "Failed to post item: API error"
    );
    const persisted = JSON.parse(
      await readFile(cacheFile, "utf-8")
    ) as string[];
    expect(persisted).not.toContain(newHash);
    expect(persisted).toEqual([oldHash]);
  });
});

async function writeFileHelper(path: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, contents);
}
