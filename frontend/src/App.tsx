import { BrowserRouter, Routes, Route } from "react-router-dom";

import Dashboard from "./pages/Dashboard";
import MeetingDetails from "./pages/MeetingDetails";
import NewMeeting from "./pages/NewMeeting";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />

        <Route
          path="/meeting/:id"
          element={<MeetingDetails />}
        />

        <Route
          path="/new"
          element={<NewMeeting />}
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;