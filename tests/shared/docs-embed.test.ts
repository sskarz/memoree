import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.hoisted(() => vi.fn());
const warmupMock = vi.hoisted(() => vi.fn(async () => true));
const embedMock = vi.hoisted(() => vi.fn(async (): Promise<number[] | null> => [0.1, 0.2]));
const clientMock = vi.hoisted(() => vi.fn(function (this: { warmup: typeof warmupMock; embed: typeof embedMock }) {
  this.warmup = warmupMock;
  this.embed = embedMock;
}));

vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("../../src/embeddings/client.js", () => ({ EmbedClient: clientMock }));
vi.mock("../../src/embeddings/disable.js", () => ({ embeddingsDisabled: () => false }));

import { makeDocEmbedder, makeQueryEmbedder } from "../../src/docs/embed.js";

beforeEach(() => {
  existsSyncMock.mockReset();
  warmupMock.mockClear();
  embedMock.mockClear();
  clientMock.mockClear();
});

describe("doc embedder daemon resolution", () => {
  it("uses EmbedClient's shared-daemon fallback when no bundled daemon exists", async () => {
    existsSyncMock.mockReturnValue(false);

    expect(await makeDocEmbedder()("doc")).toEqual([0.1, 0.2]);
    expect(clientMock).toHaveBeenCalledWith({});
    expect(warmupMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith("doc", "document");
  });

  it("retries once when a cold daemon returns no first vector", async () => {
    existsSyncMock.mockReturnValue(false);
    embedMock.mockResolvedValueOnce(null).mockResolvedValueOnce([0.3, 0.4]);

    expect(await makeDocEmbedder()("cold doc")).toEqual([0.3, 0.4]);
    expect(warmupMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it("uses the adjacent daemon in agent bundles", async () => {
    existsSyncMock.mockReturnValue(true);

    expect(await makeQueryEmbedder()("query")).toEqual([0.1, 0.2]);
    expect(clientMock).toHaveBeenCalledWith({
      daemonEntry: expect.stringMatching(/embeddings\/embed-daemon\.js$/),
    });
    expect(embedMock).toHaveBeenCalledWith("query", "query");
  });
});
