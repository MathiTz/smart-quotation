import { Navigate, Route, Routes } from "react-router-dom";
import { UploadRoute } from "./routes/Upload.js";
import { ReviewRoute } from "./routes/Review.js";
import { NegotiationRoute } from "./routes/Negotiation.js";
import { NegotiationsRoute } from "./routes/Negotiations.js";
import { PurchaseOrdersRoute } from "./routes/PurchaseOrders.js";
import { Sidebar, TopBar } from "./components/Nav.js";

export function App() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />

      {/* min-w-0 so the wide comparison and line-item tables scroll inside the
          column instead of stretching the flex row and shunting the sidebar. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-10">
          <Routes>
            <Route path="/" element={<UploadRoute />} />
            <Route path="/quotations/:id" element={<ReviewRoute />} />
            <Route path="/negotiations" element={<NegotiationsRoute />} />
            <Route path="/negotiations/:id" element={<NegotiationRoute />} />
            <Route path="/purchase-orders" element={<PurchaseOrdersRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
