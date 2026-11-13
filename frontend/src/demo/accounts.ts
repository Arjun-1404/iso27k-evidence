// The made-up people of the demo. All of them are fictional: the company names and addresses use the reserved
// ".example" domain, which can never belong to anyone.

export const DEMO_PASSWORD = "demo-password-123";
export const DEMO_ORG_NAME = "Harbourview Assurance";

export interface DemoAccount {
  email: string;
  fullName: string;
  /** Short label for the "Sign in as" button. */
  label: string;
  /** One line on what this person can and cannot do, shown under the button. */
  blurb: string;
}

/** The accounts offered as one-click sign-ins, in the order a visitor should try them. */
export const SIGN_IN_ACCOUNTS: readonly DemoAccount[] = [
  { email: "declan.walsh@harbourview.example", fullName: "Declan Walsh", label: "Lead auditor", blurb: "Reviews evidence, accepts or rejects it, closes and reopens audit cycles." },
  { email: "aoife.brennan@harbourview.example", fullName: "Aoife Brennan", label: "Organisation admin", blurb: "Runs the organisation: clients, users, storage, two-step sign-in policy, audit log." },
  { email: "maeve.okafor@harbourview.example", fullName: "Maeve Okafor", label: "Auditor", blurb: "Reviews evidence for her assigned clients. Cannot change what is asked for or close a cycle." },
  { email: "priya.shah@brightwave.example", fullName: "Priya Shah", label: "Client lead", blurb: "Brightwave Software's lead: sees every control, hands them out, uploads and submits evidence." },
  { email: "tom.byrne@brightwave.example", fullName: "Tom Byrne", label: "Client contributor", blurb: "Sees only the controls assigned to him. Uploads evidence and submits it for review." },
];
