import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { Boundary } from "./Boundary.tsx"
import "./app.css"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* Outside App, so a throw in App's own body is still caught. Inside it, the
		    boundary would be part of the tree that unmounts. */}
		<Boundary>
			<App />
		</Boundary>
	</StrictMode>
)
