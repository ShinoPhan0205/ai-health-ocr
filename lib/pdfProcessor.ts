import * as pdfjsLib from "pdfjs-dist";

// Dùng worker cùng phiên bản với pdfjs-dist đang cài trong dự án.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export type DocumentMarker = "PATIENT_START" | "LAB_START" | null;

export interface ValidPage {
  /** Số trang gốc trong PDF, bắt đầu từ 1. */
  pageNumber: number;
  /** Ảnh JPEG chất lượng tối ưu để gửi Gemini. */
  base64: string;
  /** Ảnh JPEG rõ hơn để hiển thị trên giao diện. */
  displayBase64: string;
  /** Dấu mốc nhận diện từ OCR vùng đầu trang. */
  documentMarker?: DocumentMarker;
  /** Văn bản OCR vùng đầu trang, phục vụ kiểm tra khi cần. */
  headerText?: string;
}

function hasVisibleContent(
  context: CanvasRenderingContext2D,
  width: number,
  height: number
): boolean {
  const sampleWidth = Math.min(180, width);
  const sampleHeight = Math.max(1, Math.round((height / width) * sampleWidth));
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;

  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) return true;

  sampleContext.drawImage(context.canvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let darkPixels = 0;
  const totalPixels = sampleWidth * sampleHeight;

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) darkPixels++;
  }

  sampleCanvas.width = 0;
  sampleCanvas.height = 0;
  return darkPixels / totalPixels >= 0.0005;
}

function normalizeOcrText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Đ/g, "D")
    .replace(/đ/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyHeader(text: string): DocumentMarker {
  const normalized = normalizeOcrText(text);

  // Tiêu đề mở đầu biểu mẫu khám sức khỏe người từ đủ 18 tuổi.
  const hasHealthTitle = normalized.includes("GIAY KHAM SUC KHOE");
  const hasAdultPhrase = normalized.includes("DINH KY") ||
    normalized.includes("TU DU 18 TUOI") ||
    normalized.includes("NGUOI TU DU 18");
  if (hasHealthTitle && hasAdultPhrase) return "PATIENT_START";

  // Tiêu đề trang đầu của phiếu xét nghiệm.
  if (normalized.includes("PHIEU KET QUA XET NGHIEM") ||
      (normalized.includes("PHIEU") && normalized.includes("KET QUA XET NGHIEM"))) {
    return "LAB_START";
  }

  return null;
}

/**
 * Đọc PDF scan, lọc trang trắng và chỉ OCR vùng đầu trang để tìm hai dấu mốc:
 * - GIẤY KHÁM SỨC KHỎE...: bắt đầu bệnh nhân.
 * - PHIẾU KẾT QUẢ XÉT NGHIỆM: dấu kết thúc phần khám của bệnh nhân.
 *   Trang xét nghiệm và các trang xét nghiệm lưu trữ tiếp theo không được gửi Gemini.
 * OCR chỉ nhận diện tiêu đề; không đọc nội dung khám/xét nghiệm và không thay thế Gemini.
 */
export async function extractAndFilterPages(file: File): Promise<ValidPage[][]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const validPages: ValidPage[] = [];

  const displayCanvas = document.createElement("canvas");
  const displayContext = displayCanvas.getContext("2d", { willReadFrequently: true });
  const aiCanvas = document.createElement("canvas");
  const aiContext = aiCanvas.getContext("2d", { willReadFrequently: true });
  const headerCanvas = document.createElement("canvas");
  const headerContext = headerCanvas.getContext("2d", { willReadFrequently: true });

  if (!displayContext || !aiContext || !headerContext) {
    await pdf.cleanup();
    throw new Error("Trình duyệt không thể khởi tạo canvas để đọc PDF.");
  }

  let ocrWorker: any = null;
  try {
    // Tải Tesseract.js động để thư viện OCR chỉ được khởi tạo ở trình duyệt.
    const { createWorker } = await import("tesseract.js");
    ocrWorker = await createWorker("vie");
    await ocrWorker.setParameters({ tessedit_pageseg_mode: "6" });

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const displayViewport = page.getViewport({ scale: 1.8 });
        displayCanvas.width = Math.ceil(displayViewport.width);
        displayCanvas.height = Math.ceil(displayViewport.height);
        displayContext.fillStyle = "#ffffff";
        displayContext.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
        await page.render({ canvasContext: displayContext, viewport: displayViewport } as any).promise;

        if (!hasVisibleContent(displayContext, displayCanvas.width, displayCanvas.height)) continue;

        const displayBase64 = displayCanvas.toDataURL("image/jpeg", 0.82);

        // Chỉ cắt 34% phía trên trang để OCR tiêu đề, không OCR toàn trang.
        headerCanvas.width = displayCanvas.width;
        headerCanvas.height = Math.max(1, Math.floor(displayCanvas.height * 0.34));
        headerContext.fillStyle = "#ffffff";
        headerContext.fillRect(0, 0, headerCanvas.width, headerCanvas.height);
        headerContext.drawImage(
          displayCanvas,
          0, 0, displayCanvas.width, headerCanvas.height,
          0, 0, headerCanvas.width, headerCanvas.height
        );

        let headerText = "";
        try {
          const ocrResult = await ocrWorker.recognize(headerCanvas);
          headerText = ocrResult?.data?.text || "";
        } catch (ocrError) {
          console.warn(`Không OCR được vùng đầu trang ${pageNumber}:`, ocrError);
        }

        const documentMarker = classifyHeader(headerText);

        const aiViewport = page.getViewport({ scale: 1.0 });
        aiCanvas.width = Math.ceil(aiViewport.width);
        aiCanvas.height = Math.ceil(aiViewport.height);
        aiContext.fillStyle = "#ffffff";
        aiContext.fillRect(0, 0, aiCanvas.width, aiCanvas.height);
        await page.render({ canvasContext: aiContext, viewport: aiViewport } as any).promise;

        const base64 = aiCanvas.toDataURL("image/jpeg", 0.62);
        validPages.push({ pageNumber, base64, displayBase64, documentMarker, headerText });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    displayCanvas.width = 0;
    displayCanvas.height = 0;
    aiCanvas.width = 0;
    aiCanvas.height = 0;
    headerCanvas.width = 0;
    headerCanvas.height = 0;
    await pdf.cleanup();
  }

  return validPages.length > 0 ? [validPages] : [];
}
