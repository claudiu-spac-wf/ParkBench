import { ControlExperimentView, MatrixPreviewRequest } from "../../../../packages/contracts/src";
import { ControlUiService } from "../control-ui/service";

export class ControlExperimentService {
  constructor(private readonly controlUi: ControlUiService) {}

  preview(request: MatrixPreviewRequest, pageToken?: string, pageSize?: number) {
    return this.controlUi.preview(request, pageToken, pageSize);
  }

  submit(
    request: { previewId: string; confirm: boolean },
    idempotencyKey?: string
  ): ControlExperimentView {
    return this.controlUi.submit(request, idempotencyKey);
  }
}
