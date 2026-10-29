import "agentic-design/styles.css";
import { mount } from "./embed";

const KEY = "agentic-tables-token";

// The Worker needs a credential on every request. Open the page as `/#token=<token>`: the fragment never goes to a server.
// The page keeps the token for this tab only, then takes it out of the address bar.
const given = /^#token=([A-Za-z0-9_-]{1,512})$/.exec(location.hash)?.[1];
if (given) {
  sessionStorage.setItem(KEY, given);
  history.replaceState(null, "", location.pathname + location.search);
}

mount(document.getElementById("root")!, { baseUrl: location.origin, getToken: () => sessionStorage.getItem(KEY) ?? undefined, themePicker: true });
