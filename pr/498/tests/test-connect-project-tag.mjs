import { describe, it, expect, run } from './bun-test-shim.mjs';
import { projectTag, lucidProjectTag } from '../pose/connect/project-tag.js';

describe("projectTag", () => {
  it("uses the basename of a posix path", () => {
    expect(projectTag("/Users/amickl/projects/my-experiment.slp").name).toBe("my-experiment.slp");
  });

  it("uses the basename of a windows path", () => {
    expect(projectTag("C:\\Users\\amickl\\projects\\my-experiment.slp").name).toBe(
      "my-experiment.slp",
    );
  });

  it("falls back to 'untitled.slp' for an unsaved project (null path)", () => {
    expect(projectTag(null).name).toBe("untitled.slp");
  });

  it("id is 8 lowercase hex characters", () => {
    const { id } = projectTag("/Users/amickl/projects/my-experiment.slp");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic: the same path always yields the same id", () => {
    const a = projectTag("/Users/amickl/projects/my-experiment.slp");
    const b = projectTag("/Users/amickl/projects/my-experiment.slp");
    expect(a).toEqual(b);
  });

  it("different paths yield different ids", () => {
    const a = projectTag("/Users/amickl/projects/a.slp");
    const b = projectTag("/Users/amickl/projects/b.slp");
    expect(a.id).not.toBe(b.id);
  });

  it("every untitled (null) project tags the same way", () => {
    expect(projectTag(null)).toEqual(projectTag(null));
  });

  it("a null path and a literal empty-string path hash the same (no path to disambiguate by)", () => {
    expect(projectTag(null).id).toBe(projectTag("").id);
  });
});

// LUCID: lucidProjectTag (not in sleap-app).
describe("lucidProjectTag", () => {
  const base = { fileName: "cage3.slp", sessionFolders: ["session_b", "session_a"] };

  it("name is the project file's basename; id is 8 lowercase hex", () => {
    const tag = lucidProjectTag(base);
    expect(tag.name).toBe("cage3.slp");
    expect(tag.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable across reopen and independent of session order", () => {
    const a = lucidProjectTag(base);
    const b = lucidProjectTag({ fileName: "cage3.slp", sessionFolders: ["session_a", "session_b"] });
    expect(a).toEqual(b);
    expect(lucidProjectTag(base)).toEqual(a);
  });

  it("does not depend on where the project lives (paths reduce to their last segment)", () => {
    const a = lucidProjectTag(base);
    const b = lucidProjectTag({
      fileName: "/Volumes/lab/cage3.slp",
      sessionFolders: ["/Volumes/lab/session_a/", "C:\\data\\session_b"],
    });
    expect(b).toEqual(a);
  });

  it("different file names or session sets give different ids", () => {
    const id = lucidProjectTag(base).id;
    expect(lucidProjectTag({ ...base, fileName: "cage4.slp" }).id).not.toBe(id);
    expect(lucidProjectTag({ ...base, sessionFolders: ["session_a"] }).id).not.toBe(id);
    expect(lucidProjectTag({ ...base, sessionFolders: ["session_a", "session_c"] }).id).not.toBe(id);
  });

  it("an unsaved project with no sessions tags like projectTag(null)", () => {
    expect(lucidProjectTag({})).toEqual(projectTag(null));
    expect(lucidProjectTag({ fileName: null, sessionFolders: [] })).toEqual(projectTag(null));
    expect(lucidProjectTag()).toEqual(projectTag(null));
  });

  it("an unsaved project still tags by its sessions", () => {
    const tag = lucidProjectTag({ sessionFolders: ["s1"] });
    expect(tag.name).toBe("untitled.slp");
    expect(tag.id).not.toBe(projectTag(null).id);
  });
});

await run();
