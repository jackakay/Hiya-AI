import { describe, expect, it } from "vitest";
import { cleanTranscript } from "./transcribe";
import { isRetryPhrase, parseTrigger, spokenSummary } from "./trigger";

describe("parseTrigger", () => {
  it.each([
    ["That's a bug, save did nothing.", "save did nothing."],
    ["that’s a bug save did nothing", "save did nothing"],
    ["Thats a bug. The list didn't refresh", "The list didn't refresh"],
    ["That is a bug because the title should be required", "the title should be required"],
    ["Okay, that's a bug, I expected an error message", "I expected an error message"],
    ["Bug: clicking save does nothing", "clicking save does nothing"],
    ["Bug report, the counter is off by one", "the counter is off by one"],
    ["That's another bug", ""],
    ["that's a bag, nothing happened", "nothing happened"],
    ["I found a bug, the page went blank", "the page went blank"],
  ])("%j triggers with note %j", (transcript, note) => {
    expect(parseTrigger(transcript)).toEqual({ triggered: true, note });
  });

  it.each([
    "Let me click save again",
    "Debugging this is fun",
    "There's a ladybug on my desk",
    "",
    "bugs are annoying",
  ])("%j is ignored", (transcript) => {
    expect(parseTrigger(transcript)).toEqual({ triggered: false });
  });
});

describe("isRetryPhrase", () => {
  it.each(["Try again.", "try it again please", "Okay, try again", "Retry", "Can you send it again?", "resend"])("%j retries", (t) => {
    expect(isRetryPhrase(t)).toBe(true);
  });
  it.each(["Let me try again with a longer title", "that's a bug, try again shows nothing", "again", ""])("%j doesn't", (t) => {
    expect(isRetryPhrase(t)).toBe(false);
  });
});

describe("spokenSummary", () => {
  it("says the title and where, without file extensions", () => {
    expect(spokenSummary({ title: "Saving an empty note crashes the server.", rootCause: { file: "demo-app/server/index.ts", line: 19, confidence: "high" } })).toBe(
      "Saving an empty note crashes the server. In index, line 19.",
    );
  });

  it("asks the follow-up question when unsure", () => {
    expect(
      spokenSummary({ title: "List doesn't refresh", rootCause: { file: "", line: 0, confidence: "low" }, followUpQuestion: "Did you reload the page first?" }),
    ).toBe("List doesn't refresh. Did you reload the page first?");
  });
});

describe("cleanTranscript", () => {
  it.each([
    ['"That\'s a bug."', "That's a bug."],
    ["Transcript: that's a bug", "that's a bug"],
    ["  that's   a\nbug  ", "that's a bug"],
    ["", ""],
  ])("%j -> %j", (raw, expected) => expect(cleanTranscript(raw)).toBe(expected));
});
