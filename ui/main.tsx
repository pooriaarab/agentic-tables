import "agentic-design/styles.css";
import { mount } from "./embed";

// The Worker reads the caller from headers and proves nothing yet, so this page is for a local Worker.
mount(document.getElementById("root")!, { baseUrl: location.origin, principal: { id: "local-user", kind: "human" } });
