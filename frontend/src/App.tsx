import { BrowserRouter, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import Analytics from "./pages/Analytics";
import Ask from "./pages/Ask";
import Dashboard from "./pages/Dashboard";
import LiveMeeting from "./pages/LiveMeeting";
import MeetingDetails from "./pages/MeetingDetails";
import NewMeeting from "./pages/NewMeeting";
import NotFound from "./pages/NotFound";
import Tasks from "./pages/Tasks";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/meeting/:id" element={<MeetingDetails />} />
          <Route path="/new" element={<NewMeeting />} />
          <Route path="/live" element={<LiveMeeting />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
