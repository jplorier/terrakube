import { EditOutlined, MinusOutlined, PlusOutlined, SyncOutlined } from "@ant-design/icons";
import { Collapse, Tag } from "antd";
import { useMemo } from "react";
import { stripAnsi } from "./stripAnsi";
import "./PlanView.css";

type ChangeSymbol = "+" | "-" | "~" | "-/+" | "+/-" | "<=" | "?";

type ResourceBlock = {
  address: string;
  actionDesc: string;
  changeSymbol: ChangeSymbol;
  lines: string[];
};

type ParsedOutput = {
  preamble: string[];
  resources: ResourceBlock[];
  summaryLine: string;
  footer: string[];
};

function parseTerraformOutput(rawOutput: string): ParsedOutput {
  const output = stripAnsi(rawOutput);
  const lines = output.split("\n");
  const resources: ResourceBlock[] = [];
  const preambleLines: string[] = [];
  const footerLines: string[] = [];
  let summaryLine = "";
  let inResources = false;
  let afterSummary = false;
  let currentResource: ResourceBlock | null = null;

  for (const line of lines) {
    if (afterSummary) {
      footerLines.push(line);
      continue;
    }

    // Resource header: "  # address will be created / must be replaced / ..."
    const headerMatch = line.match(/^\s{1,6}#\s+(\S+)\s+(?:will be|must be)\s+(.+)/);
    if (headerMatch) {
      if (currentResource) resources.push(currentResource);
      inResources = true;
      const address = headerMatch[1];
      const actionDesc = headerMatch[2];
      let changeSymbol: ChangeSymbol = "?";
      if (actionDesc.startsWith("creat")) changeSymbol = "+";
      else if (actionDesc.startsWith("destroy")) changeSymbol = "-";
      else if (actionDesc.startsWith("updat")) changeSymbol = "~";
      else if (actionDesc.startsWith("replac")) changeSymbol = "-/+";
      else if (actionDesc.startsWith("read")) changeSymbol = "<=";
      currentResource = { address, actionDesc, changeSymbol, lines: [] };
      continue;
    }

    // Summary / completion lines
    if (/^Plan:|^Apply complete|^No changes|^Destroy complete/.test(line)) {
      if (currentResource) {
        resources.push(currentResource);
        currentResource = null;
      }
      summaryLine = line;
      afterSummary = true;
      continue;
    }

    if (currentResource) {
      currentResource.lines.push(line);
    } else if (!inResources) {
      preambleLines.push(line);
    }
  }

  if (currentResource) resources.push(currentResource);

  return { preamble: preambleLines, resources, summaryLine, footer: footerLines };
}

function parseSummary(line: string) {
  const add = line.match(/(\d+) to add/);
  const change = line.match(/(\d+) to change/);
  const destroy = line.match(/(\d+) to destroy/);
  return {
    toAdd: add ? parseInt(add[1]) : 0,
    toChange: change ? parseInt(change[1]) : 0,
    toDestroy: destroy ? parseInt(destroy[1]) : 0,
  };
}

function getChangeConfig(symbol: ChangeSymbol) {
  switch (symbol) {
    case "+":
      return { color: "success" as const, label: "create", icon: <PlusOutlined />, borderColor: "#52c41a", bgColor: "#f6ffed" };
    case "-":
      return { color: "error" as const, label: "destroy", icon: <MinusOutlined />, borderColor: "#ff4d4f", bgColor: "#fff2f0" };
    case "~":
      return { color: "warning" as const, label: "update", icon: <EditOutlined />, borderColor: "#faad14", bgColor: "#fffbe6" };
    case "-/+":
    case "+/-":
      return { color: "processing" as const, label: "replace", icon: <SyncOutlined />, borderColor: "#1677ff", bgColor: "#e6f4ff" };
    case "<=":
      return { color: "default" as const, label: "read", icon: <SyncOutlined />, borderColor: "#d9d9d9", bgColor: "#fafafa" };
    default:
      return { color: "default" as const, label: symbol, icon: null, borderColor: "#d9d9d9", bgColor: "#fafafa" };
  }
}

function getLineClass(line: string): string {
  const trimmed = line.trimStart();
  if (/^\+/.test(trimmed)) return "plan-line plan-line-add";
  if (/^-/.test(trimmed)) return "plan-line plan-line-remove";
  if (/^~/.test(trimmed)) return "plan-line plan-line-update";
  if (/^#/.test(trimmed)) return "plan-line plan-line-comment";
  return "plan-line";
}

type Props = {
  outputLog: string;
};

export const PlanView = ({ outputLog }: Props) => {
  const parsed = useMemo(() => parseTerraformOutput(outputLog), [outputLog]);
  const summary = parsed.summaryLine ? parseSummary(parsed.summaryLine) : null;
  const hasResources = parsed.resources.length > 0;

  return (
    <div className="plan-view">
      {summary && (
        <div className="plan-summary-badges">
          {summary.toAdd > 0 && (
            <Tag color="success">
              <PlusOutlined /> {summary.toAdd} to add
            </Tag>
          )}
          {summary.toChange > 0 && (
            <Tag color="warning">
              <EditOutlined /> {summary.toChange} to change
            </Tag>
          )}
          {summary.toDestroy > 0 && (
            <Tag color="error">
              <MinusOutlined /> {summary.toDestroy} to destroy
            </Tag>
          )}
          {summary.toAdd === 0 && summary.toChange === 0 && summary.toDestroy === 0 && (
            <Tag color="default">No changes</Tag>
          )}
        </div>
      )}

      {!hasResources && (
        <pre className="plan-preamble">{stripAnsi(outputLog)}</pre>
      )}

      {hasResources && (
        <>
          {parsed.preamble.length > 0 && (
            <details className="plan-preamble-details">
              <summary className="plan-preamble-summary">Initialization output</summary>
              <pre className="plan-preamble">{parsed.preamble.join("\n")}</pre>
            </details>
          )}

          <Collapse
            className="plan-resources-collapse"
            items={parsed.resources.map((resource, idx) => {
              const config = getChangeConfig(resource.changeSymbol);
              return {
                key: idx,
                label: (
                  <span className="plan-resource-label">
                    <Tag color={config.color}>{resource.changeSymbol}</Tag>
                    <code className="plan-resource-address">{resource.address}</code>
                    <span className="plan-resource-action"> will be {resource.actionDesc}</span>
                  </span>
                ),
                style: {
                  borderLeft: `4px solid ${config.borderColor}`,
                  backgroundColor: config.bgColor,
                  marginBottom: "4px",
                },
                children: (
                  <div className="plan-resource-lines">
                    {resource.lines.map((line, i) => (
                      <div key={i} className={getLineClass(line)}>
                        {line || "\u00A0"}
                      </div>
                    ))}
                  </div>
                ),
              };
            })}
          />
        </>
      )}

      {parsed.summaryLine && (
        <div className="plan-summary-line">{parsed.summaryLine}</div>
      )}
    </div>
  );
};
