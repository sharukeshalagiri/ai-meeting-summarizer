import { vi } from "vitest";

/**
 * Global test setup for accounts (w4-acct), registered in
 * vitest.config.mts.
 *
 * Route tests written before accounts mock the repositories they need
 * and send no credentials. To keep them meaningful without a database:
 * - every request is signed in as TEST_USER, unless it sends an
 *   `x-test-user: <id>` header (then it is that user) or device auth set
 *   req.user first;
 * - every ownership lookup answers TEST_USER, so their rows are "mine";
 * - account settings resolve to the server defaults.
 *
 * Suites that test accounts themselves (test/w4-acct/) override these
 * mocks per test (vi.mocked(...).mockImplementation) or import the real
 * modules with vi.importActual.
 */

export const TEST_USER = { id: "test-user", name: "Test User", email: "test@example.com" };

vi.mock("../src/lib/auth/currentUser", () => ({
  resolveUser: vi.fn((req: { user?: unknown; header: (name: string) => string | undefined }) => {
    if (req.user && typeof (req.user as { id?: unknown }).id === "string") return req.user;
    const id = req.header("x-test-user");
    if (id === "anonymous") return null;
    return id ? { id, name: id, email: `${id}@example.com` } : TEST_USER;
  }),
}));

vi.mock("../src/repositories/access.repository", () => ({
  meetingOwnerId: vi.fn(async () => TEST_USER.id),
  liveSessionOwnerId: vi.fn(async () => TEST_USER.id),
  actionItemOwnerId: vi.fn(async () => TEST_USER.id),
  seriesOwnerId: vi.fn(async () => TEST_USER.id),
  conversationOwnerId: vi.fn(async () => null),
}));

vi.mock("../src/services/account/context", () => ({
  settingsForMeeting: vi.fn(async () => null),
  settingsForAudioPath: vi.fn(async () => null),
  meLabelForMeeting: vi.fn(async () => process.env.ME_DISPLAY_NAME || "You"),
  defaultModeFor: vi.fn(async () => null),
}));
