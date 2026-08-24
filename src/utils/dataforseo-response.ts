export type DataForSeoTask = Record<string, any> & {
  result?: any;
  status_code?: number;
  status_message?: string;
};

export type DataForSeoResponse = {
  tasks?: DataForSeoTask[];
};

export async function readDataForSeoResponse(response: {
  json(): Promise<unknown>;
}): Promise<DataForSeoResponse> {
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const tasks = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return {};

  return {
    tasks: tasks.filter(
      (task): task is DataForSeoTask =>
        task !== null && typeof task === "object" && !Array.isArray(task),
    ),
  };
}
