workspace "Decision HUD" "C4 model of the current decision-hud desktop plugin repository" {
    model {
        owner = person "Owner" "Reviews decisions, projects, telemetry, and planning state in the Hermes desktop app."
        agent = person "Hermes Agent / Sidecar" "Produces decisions and workflow data through the Hermes plugin and MCP surfaces."

        hermes = softwareSystem "Hermes Desktop" "Host desktop application and plugin runtime." {
            desktopPlugin = container "Decision HUD desktop plugin" "Docked React/ESM pane for decisions, projects, workflow views, and agent dashboard." "JavaScript / React / Hermes Plugin SDK"
            cliGateway = container "Hermes CLI gateway" "Executes hermes decision and hermes kanban commands requested by the desktop plugin." "Hermes JSON-RPC cli.exec"
            pluginStore = container "Decision HUD plugin store" "SQLite-backed durable decision queue and workflow configuration owned by the companion Hermes plugin." "SQLite / hermes decision CLI"
        }

        telemetry = softwareSystem "Agent Dashboard telemetry service" "Read-only telemetry service included in this repository." {
            httpApi = container "Agent Dashboard HTTP API" "Loopback-only authenticated API for dashboard, comparison, and history reads." "Python stdlib http.server / JSON"
            readModel = container "Dashboard read model" "Builds dashboard snapshots and comparison/history projections from telemetry repositories." "Python"
            postgres = container "Telemetry PostgreSQL" "Durable telemetry snapshots and source metrics." "PostgreSQL"
        }

        mcp = softwareSystem "Decision HUD MCP server" "Companion MCP surface used by agents to push decisions and workflow requests." "External / Hermes plugin"
        hermesCore = softwareSystem "Hermes core services" "Existing Hermes CLI, gateway, and runtime services." "External / Hermes"

        owner -> hermes "Uses"
        agent -> mcp "Pushes decisions and workflow requests"
        mcp -> pluginStore "Writes durable decision/workflow state"
        desktopPlugin -> cliGateway "Requests decision and workflow data" "cli.exec RPC"
        cliGateway -> pluginStore "Reads/writes decisions and settings"
        desktopPlugin -> httpApi "Reads authenticated agent dashboard data" "HTTP / loopback"
        httpApi -> readModel "Queries authenticated read model"
        readModel -> postgres "Reads telemetry snapshots"
        cliGateway -> hermesCore "Uses host CLI/gateway"
    }

    views {
        systemContext hermes {
            include *
            autoLayout lr
            title "Decision HUD — System Context"
        }

        container hermes {
            include *
            autoLayout lr
            title "Decision HUD — Containers"
        }

        container telemetry {
            include *
            autoLayout lr
            title "Agent Dashboard telemetry — Containers"
        }

        component desktopPlugin {
            include *
            autoLayout lr
            title "Decision HUD desktop plugin — Components"
        }

        styles {
            element "Person" {
                shape person
                background #2563eb
                color #ffffff
            }
            element "Software System" {
                background #0f766e
                color #ffffff
            }
            element "Container" {
                background #1d4ed8
                color #ffffff
            }
            element "External" {
                background #64748b
                color #ffffff
            }
        }
    }
}
