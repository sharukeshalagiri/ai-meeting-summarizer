interface Props {
  message: string;
  onRetry?: () => void;
}

/** Shared failure state, so every page reports errors identically. */
function ErrorState({ message, onRetry }: Props) {
  return (
    <div className="error-state">
      <div role="alert" className="alert">
        {message}
      </div>

      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export default ErrorState;
