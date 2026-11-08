import * as pdfjsLib from "pdfjs-dist";

// Dùng CDN để load Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export interface ValidPage {
  pageNumber: number;
  base64: string;        // Ảnh mờ, dung lượng thấp dành cho AI
  displayBase64: string; // Ảnh nét, độ phân giải cao dành cho UI
}

export async function extractAndFilterPages(file: File): Promise<ValidPage[][]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  const patients: ValidPage[][] = [];
  let currentPatientPages: ValidPage[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);

    // BƯỚC 1: Đọc lớp văn bản (Text Layer) để tìm điểm cắt
    const textContent = await page.getTextContent();
    const textString = textContent.items.map((item: any) => item.str).join(" ").toUpperCase();

    const isNewPatient = textString.includes("GIẤY KHÁM SỨC KHỎE") || 
                         textString.includes("SỔ KHÁM SỨC KHỎE") || 
                         textString.includes("SỐ THỨ TỰ");

    if (isNewPatient && currentPatientPages.length > 0) {
      patients.push(currentPatientPages);
      currentPatientPages = [];
    }

    // BƯỚC 2: TẠO ẢNH NÉT (Scale 2.0) DÀNH CHO NGƯỜI DÙNG XEM (UI)
    const displayViewport = page.getViewport({ scale: 2.0 }); // Scale to để nét
    const displayCanvas = document.createElement("canvas");
    const displayContext = displayCanvas.getContext("2d");
    displayCanvas.height = displayViewport.height;
    displayCanvas.width = displayViewport.width;

    if (displayContext) {
      const renderContext: any = { canvasContext: displayContext, viewport: displayViewport };
      await page.render(renderContext).promise;
      const displayBase64 = displayCanvas.toDataURL("image/jpeg", 0.8); // Chất lượng cao

      // BƯỚC 3: TẠO ẢNH MỜ (Scale 0.8) DÀNH CHO AI (Giảm payload)
      // Mẹo: Dùng drawImage để copy và thu nhỏ từ ảnh nét, tiết kiệm thời gian không phải render PDF lại
      const aiViewport = page.getViewport({ scale: 0.8 }); 
      const aiCanvas = document.createElement("canvas");
      const aiContext = aiCanvas.getContext("2d");
      aiCanvas.height = aiViewport.height;
      aiCanvas.width = aiViewport.width;

      if (aiContext) {
        aiContext.drawImage(displayCanvas, 0, 0, displayCanvas.width, displayCanvas.height, 0, 0, aiCanvas.width, aiCanvas.height);
        const base64 = aiCanvas.toDataURL("image/jpeg", 0.4); // Ép chất lượng xuống

        if (base64.length > 10000) {
          currentPatientPages.push({ pageNumber: i, base64, displayBase64 });
        }
      }
    }
  }

  if (currentPatientPages.length > 0) {
    patients.push(currentPatientPages);
  }

  return patients;
}