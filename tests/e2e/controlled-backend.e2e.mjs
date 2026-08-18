import assert from "node:assert/strict";

describe("BeatGaler controlled Tauri backend E2E", () => {
  it("loads the WDIO bridge inside the isolated BeatGaler executable", async () => {
    const available = await browser.tauri.execute(() => {
      return typeof window.wdioTauri !== "undefined";
    });

    assert.equal(
      available,
      true,
      "The isolated E2E binary opened, but the WDIO Tauri bridge is unavailable.",
    );
  });

  it("can replace load_library with an isolated fake library", async () => {
    const fixture = [
      {
        id: "e2e-purple-beat",
        name: "E2E Purple Beat",
        folder_path: "E:\\BeatGaler-E2E\\E2E Purple Beat",
        mp3_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.mp3",
        wav_path: null,
        playback_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.mp3",
        bpm: "140",
        key: "cm",
        needs_resolution: false,
        tags: ["e2e", "dark"],
        rating: 5,
        image_base64: null,
        has_wav: false,
        has_stems: false,
        has_samples: true,
        samples_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\Samples",
        has_flp: true,
        has_als: false,
        stems_path: null,
        flp_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.flp",
        als_path: null,
        other_files: [],
        color: "#442584",
        color2: "#701f6a",
        has_loop: false,
        loop_path: null,
      },
    ];

    const mock = await browser.tauri.mock("load_library");
    await mock.mockReturnValue(fixture);

    const result = await browser.tauri.execute(({ core }) => {
      return core.invoke("load_library");
    });

    assert.deepEqual(result, fixture);
    assert.equal(result[0].name, "E2E Purple Beat");
    assert.equal(result[0].rating, 5);
  });

  it("can replace get_settings without reading the real user's settings", async () => {
    const fakeSettings = {
      beats_folder: "E:\\BeatGaler-E2E",
      incomplete_warnings_enabled: true,
      custom_cursor_enabled: true,
    };

    const mock = await browser.tauri.mock("get_settings");
    await mock.mockReturnValue(fakeSettings);

    const result = await browser.tauri.execute(({ core }) => {
      return core.invoke("get_settings");
    });

    assert.equal(result.beats_folder, "E:\\BeatGaler-E2E");
    assert.equal(result.incomplete_warnings_enabled, true);
  });

  it("can isolate a mutating command so production data is not touched", async () => {
    const fakeResult = {
      new_mp3_path: "E:\\BeatGaler-E2E\\Saved Beat\\Saved Beat.mp3",
      new_wav_path: null,
    };

    const mock = await browser.tauri.mock("save_beat_meta");
    await mock.mockReturnValue(fakeResult);

    const result = await browser.tauri.execute(({ core }) => {
      return core.invoke("save_beat_meta", {
        payload: {
          id: "e2e-purple-beat",
          name: "Saved Beat",
          mp3_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.mp3",
          wav_path: null,
          bpm: "150",
          key: "dm",
          tags: ["e2e"],
          rating: 4,
        },
      });
    });

    assert.deepEqual(result, fakeResult);
  });
});
