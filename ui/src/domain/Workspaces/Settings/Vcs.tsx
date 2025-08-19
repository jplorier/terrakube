import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Card, Form, Select, Spin, Switch, Typography, message, Space, Divider } from "antd";
import { useEffect, useState } from "react";
import axiosInstance from "../../../config/axiosConfig";
import { VcsModel, Workspace } from "../../types";
import { genericHeader, renderVCSLogo } from "../Workspaces";

type Props = {
  workspace: Workspace;
  manageWorkspace: boolean;
};

type UpdateWorkspaceVcsForm = {
  vcsId: string | null;
};

export const WorkspaceVcs = ({ workspace, manageWorkspace }: Props) => {
  const organizationId = workspace.relationships.organization.data.id;
  const workspaceId = workspace.id;
  const [form] = Form.useForm();
  const [waiting, setWaiting] = useState(false);
  const [vcsConnections, setVcsConnections] = useState<VcsModel[]>([]);
  const [currentVcsId, setCurrentVcsId] = useState<string | null>(null);
  const [isVcsConnected, setIsVcsConnected] = useState(false);

  useEffect(() => {
    loadVcsConnections();
    // Check if workspace has a VCS connection
    if (workspace.relationships.vcs?.data?.id) {
      setCurrentVcsId(workspace.relationships.vcs.data.id);
      setIsVcsConnected(true);
      form.setFieldValue('vcsId', workspace.relationships.vcs.data.id);
    }
  }, [workspace]);

  const loadVcsConnections = () => {
    setWaiting(true);
    axiosInstance
      .get(`organization/${organizationId}/vcs`)
      .then((response: any) => {
        setVcsConnections(response.data.data);
      })
      .catch((error: any) => {
        console.error("Error loading VCS connections:", error);
        message.error("Failed to load VCS connections");
      })
      .finally(() => {
        setWaiting(false);
      });
  };

  const onFinish = (values: UpdateWorkspaceVcsForm) => {
    setWaiting(true);

    let bodyVcs;
    if (values.vcsId && values.vcsId !== "none") {
      bodyVcs = {
        data: {
          type: "vcs",
          id: values.vcsId,
        },
      };
    } else {
      bodyVcs = {
        data: null,
      };
    }

    axiosInstance
      .patch(`/organization/${organizationId}/workspace/${workspaceId}/relationships/vcs`, bodyVcs, genericHeader)
      .then((response: any) => {
        if (response.status === 204) {
          message.success("VCS connection updated successfully");
          if (values.vcsId && values.vcsId !== "none") {
            setCurrentVcsId(values.vcsId);
            setIsVcsConnected(true);
          } else {
            setCurrentVcsId(null);
            setIsVcsConnected(false);
          }
        } else {
          message.error("Failed to update VCS connection");
        }
      })
      .catch((error: any) => {
        console.error("Error updating VCS connection:", error);
        message.error("Failed to update VCS connection");
      })
      .finally(() => {
        setWaiting(false);
      });
  };

  const handleVcsToggle = (checked: boolean) => {
    setIsVcsConnected(checked);
    if (!checked) {
      form.setFieldValue('vcsId', 'none');
    } else if (currentVcsId) {
      form.setFieldValue('vcsId', currentVcsId);
    }
  };

  const getCurrentVcsConnection = () => {
    if (currentVcsId) {
      return vcsConnections.find((vcs: VcsModel) => vcs.id === currentVcsId);
    }
    return null;
  };

  const currentVcs = getCurrentVcsConnection();

  return (
    <div style={{ width: "100%" }} className="vcsSettings">
      <h1>VCS Connection</h1>
      <Typography.Paragraph type="secondary">
        Configure version control system integration for this workspace. This determines which repository 
        the workspace is connected to and how it triggers runs based on changes.
      </Typography.Paragraph>

      <Spin spinning={waiting}>
        {currentVcs && (
          <Card 
            title={
              <Space>
                {renderVCSLogo(currentVcs.attributes.vcsType)}
                Current VCS Connection: {currentVcs.attributes.name}
              </Space>
            }
            style={{ marginBottom: 24 }}
            type="inner"
          >
            <Typography.Text type="secondary">
              <strong>ID:</strong>
            </Typography.Text>
            <Typography.Paragraph copyable={{ tooltips: false }} style={{ display: "inline", marginLeft: 8 }}>
              <span className="App-text">{currentVcs.id}</span>
            </Typography.Paragraph>
            <br />
            <Typography.Text type="secondary">
              <strong>Type:</strong> {currentVcs.attributes.vcsType}
            </Typography.Text>
            <br />
            <Typography.Text type="secondary">
              <strong>Description:</strong> {currentVcs.attributes.description}
            </Typography.Text>
            <br />
            <Typography.Text type="secondary">
              <strong>Status:</strong> {currentVcs.attributes.status}
            </Typography.Text>
          </Card>
        )}

        <Form
          form={form}
          onFinish={onFinish}
          layout="vertical"
          name="workspace-vcs-settings"
          initialValues={{
            vcsId: currentVcsId || 'none',
          }}
        >
          <Form.Item
            label="Enable VCS Connection"
            tooltip={{
              title: "Enable or disable VCS integration for this workspace",
              icon: <InfoCircleOutlined />,
            }}
          >
            <Switch 
              checked={isVcsConnected} 
              onChange={handleVcsToggle} 
              disabled={!manageWorkspace}
              checkedChildren="Enabled"
              unCheckedChildren="Disabled"
            />
          </Form.Item>

          {isVcsConnected && (
            <>
              <Divider />
              <Form.Item
                name="vcsId"
                label="VCS Provider"
                tooltip={{
                  title: "Select the VCS provider this workspace should connect to",
                  icon: <InfoCircleOutlined />,
                }}
                extra="Choose a VCS provider to connect this workspace to a git repository"
                rules={[
                  {
                    required: isVcsConnected,
                    message: "Please select a VCS provider when VCS connection is enabled",
                  },
                ]}
              >
                <Select
                  placeholder="Select a VCS provider"
                  style={{ width: "100%" }}
                  disabled={!manageWorkspace}
                  allowClear
                >
                  <Select.Option value="none">No VCS Connection</Select.Option>
                  {vcsConnections.map((vcs: VcsModel) => (
                    <Select.Option key={vcs.id} value={vcs.id}>
                      <Space>
                        {renderVCSLogo(vcs.attributes.vcsType)}
                        {vcs.attributes.name} ({vcs.attributes.vcsType})
                      </Space>
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              {vcsConnections.length === 0 && (
                <Typography.Text type="warning">
                  No VCS providers are configured for this organization. 
                  Please configure a VCS provider in the organization settings first.
                </Typography.Text>
              )}
            </>
          )}

          <Form.Item>
            <Button type="primary" htmlType="submit" disabled={!manageWorkspace}>
              Save VCS Settings
            </Button>
          </Form.Item>
        </Form>

        {!isVcsConnected && (
          <Typography.Text type="secondary">
            <strong>Note:</strong> When VCS connection is disabled, this workspace operates in CLI-driven mode. 
            You'll need to manually trigger runs using the Terrakube CLI or API.
          </Typography.Text>
        )}
      </Spin>
    </div>
  );
};
