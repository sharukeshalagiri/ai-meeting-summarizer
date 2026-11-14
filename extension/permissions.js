/**
 * One-time microphone grant for the extension's origin.
 *
 * Offscreen documents cannot prompt for permissions, but they inherit a
 * grant made by any visible extension page. This page asks once, then
 * releases the mic immediately.
 */
const result = document.getElementById("result");
const button = document.getElementById("grant");

const show = (text, ok) => {
  result.textContent = text;
  result.className = ok ? "ok" : "error";
};

const refresh = async () => {
  try {
    const state = await navigator.permissions.query({ name: "microphone" });

    if (state.state === "granted") {
      show("Microphone allowed. You can close this tab and start recording from the toolbar.", true);
      button.disabled = true;
    }
  } catch {
    // permissions.query is unsupported for the mic in some builds; the button still works.
  }
};

button.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    stream.getTracks().forEach((track) => track.stop());
    show("Microphone allowed. You can close this tab and start recording from the toolbar.", true);
    button.disabled = true;
  } catch (error) {
    show(
      error?.name === "NotAllowedError"
        ? "Blocked. Click the icon at the right of the address bar, allow the microphone, then try again."
        : `Could not open the microphone: ${error?.message ?? error}`,
      false
    );
  }
});

void refresh();
