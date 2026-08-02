import type { ReactNode } from "react";

interface Props {
  title: string;
  body?: string;
  /** Optional call to action, e.g. a link to the upload page. */
  action?: ReactNode;
  icon?: ReactNode;
}

/**
 * Shared empty and interstitial state, so "nothing here yet" looks the
 * same everywhere instead of being improvised per page.
 */
function EmptyState({ title, body, action, icon }: Props) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}

      <h3>{title}</h3>

      {body && <p className="muted">{body}</p>}

      {action && <div className="actions center">{action}</div>}
    </div>
  );
}

export default EmptyState;
