import { Link } from "react-router-dom";
import EmptyState from "../components/EmptyState";

function NotFound() {
  return (
    <div className="page">
      <EmptyState
        title="Page not found"
        body="That link does not lead anywhere."
        action={
          <Link to="/">
            <button type="button">Back to meetings</button>
          </Link>
        }
      />
    </div>
  );
}

export default NotFound;
