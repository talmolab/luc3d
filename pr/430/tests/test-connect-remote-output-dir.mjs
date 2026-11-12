import { describe, it, expect, run } from './bun-test-shim.mjs';
import { defaultOutputDir, projectFolderName } from '../pose/connect/remote-output-dir.js';

const MOUNTS = ["/root/vast/amick"];
const RULES = [{ local: "/Volumes/talmo/amick", worker: "/root/vast/amick" }];

describe("projectFolderName", () => {
  it("drops .slp / .pkg.slp and slashes", () => {
    expect(projectFolderName("labels.v002.slp")).toBe("labels.v002");
    expect(projectFolderName("flies.pkg.slp")).toBe("flies");
    expect(projectFolderName("a/b.slp")).toBe("a_b");
    expect(projectFolderName(".slp")).toBe("untitled");
  });
});

describe("defaultOutputDir", () => {
  const base = {
    projectName: "labels.v002.slp",
    rules: RULES,
    mounts: MOUNTS,
    serveFolder: "/root/vast/amick",
  };

  it("uses the project's own folder on the worker when a rule maps it into a shared folder", async () => {
    const checked = [];
    const result = await defaultOutputDir({
      ...base,
      projectPath: "/Volumes/talmo/amick/tutorial/labels.v002.slp",
      isSharedFolder: async (p) => {
        checked.push(p);
        return true;
      },
    });
    expect(result).toEqual({ dir: "/root/vast/amick/tutorial", source: "project" });
    expect(checked).toEqual(["/root/vast/amick/tutorial"]);
  });

  it("falls back to <serve folder>/sleap-connect/<project> when the project folder isn't on the worker", async () => {
    const result = await defaultOutputDir({
      ...base,
      projectPath: "/Users/me/Desktop/labels.v002.slp",
      isSharedFolder: async () => true,
    });
    expect(result).toEqual({ dir: "/root/vast/amick/sleap-connect/labels.v002", source: "serve-folder" });
  });

  it("falls back when the mapped folder doesn't exist there", async () => {
    const result = await defaultOutputDir({
      ...base,
      projectPath: "/Volumes/talmo/amick/gone/labels.v002.slp",
      isSharedFolder: async () => false,
    });
    expect(result?.source).toBe("serve-folder");
  });

  it("unsaved project → serve folder; no serve folder either → null", async () => {
    expect(
      (await defaultOutputDir({ ...base, projectPath: null, isSharedFolder: async () => true }))?.source,
    ).toBe("serve-folder");
    expect(
      await defaultOutputDir({ ...base, serveFolder: null, projectPath: null, isSharedFolder: async () => true }),
    ).toBeNull();
  });
});

await run();
