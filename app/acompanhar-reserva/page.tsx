import type { Metadata } from "next";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { ReservationLookup } from "@/components/reservation/reservation-lookup";

export const metadata: Metadata = { title: "Acompanhar reserva" };

export default function TrackReservationPage() {
  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-12 sm:py-20 lg:py-28"><ReservationLookup /></div>
      <Footer />
    </main>
  );
}
