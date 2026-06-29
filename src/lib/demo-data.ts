// Demo/mock stats helpers — used to populate dashboards while the app is being seeded
// with real users. These numbers are deterministic per id so the UI feels alive.

export type DemoCanvasser = {
  id: string;
  name: string;
  teamId: string;
  doorsKnocked: number;
  contactsMade: number;
  salesClosed: number;
  revenueGenerated: number;
  level: number;
};

const NAMES: string[] = [];

function seed(id: string) {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
}

export const DEMO_TEAMS: { id: string; name: string; color: string; captain: string }[] = [];

export function demoCanvassers(): DemoCanvasser[] {
  return NAMES.map((name, i) => {
    const teamId = DEMO_TEAMS[i % 3].id;
    const id = `demo-${i}`;
    const rnd = seed(id);
    const doors = 200 + Math.floor(rnd() * 600);
    const contacts = Math.floor(doors * (0.25 + rnd() * 0.25));
    const sales = Math.floor(contacts * (0.15 + rnd() * 0.2));
    const revenue = sales * (800 + Math.floor(rnd() * 1400));
    return {
      id, name, teamId,
      doorsKnocked: doors, contactsMade: contacts, salesClosed: sales,
      revenueGenerated: revenue,
      level: 1 + Math.floor(sales / 6),
    };
  });
}

export function teamTotals(teamId: string) {
  const members = demoCanvassers().filter((c) => c.teamId === teamId);
  return members.reduce(
    (acc, m) => ({
      doors: acc.doors + m.doorsKnocked,
      contacts: acc.contacts + m.contactsMade,
      sales: acc.sales + m.salesClosed,
      revenue: acc.revenue + m.revenueGenerated,
      members: acc.members + 1,
    }),
    { doors: 0, contacts: 0, sales: 0, revenue: 0, members: 0 },
  );
}

export function formatCurrency(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
