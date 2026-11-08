import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    // 1. NHẬN THÊM docType TỪ FRONTEND
    const { pages, modelId, docType = "ADULT_18" } = await req.json();
    
    // Lựa chọn API Key và Model tương ứng
    const isModel2 = modelId === "MODEL_2";
    const apiKey = isModel2 ? process.env.GEMINI_API_KEY_2 : process.env.GEMINI_API_KEY_1;
    const modelName = isModel2 ? "gemini-3.5-flash-lite" : "gemini-3.1-flash-lite"; // Chỉnh lại theo tên model thực tế của bạn

    if (!apiKey) {
      return NextResponse.json({ 
        error: `Chưa cấu hình ${isModel2 ? 'GEMINI_API_KEY_2' : 'GEMINI_API_KEY_1'} trong file .env.local` 
      }, { status: 500 });
    }

    const imageParts = pages.map((page: any) => ({
      inlineData: { mimeType: "image/jpeg", data: page.base64.split(",")[1] }
    }));

    // 2. CẤU HÌNH PROMPT VÀ JSON SCHEMA THEO TỪNG LOẠI HỒ SƠ
    let prompt = "";
    let responseSchema: any = null;

    if (docType === "STUDENT") {
      prompt = `Bạn là chuyên gia bóc tách dữ liệu y tế. Hãy trích xuất thông tin từ Phiếu Kiểm Tra Sức Khỏe Học Sinh Phổ Thông. Đọc các trang scan và nhóm lại theo từng học sinh. Nếu thông tin nào không có, hãy để chuỗi rỗng "". TUYỆT ĐỐI phải có page_start và page_end.`;
      
      // JSON Schema cho Học sinh (Gemini REST API yêu cầu type in hoa)
      responseSchema = {
        type: "ARRAY",
        description: "Danh sách hồ sơ học sinh",
        items: {
          type: "OBJECT",
          properties: {
            page_start: { type: "INTEGER", description: "Trang bắt đầu của học sinh này (từ 0)" },
            page_end: { type: "INTEGER", description: "Trang kết thúc" },
            fullName: { type: "STRING", description: "Họ và tên" },
            dateOfBirth: { type: "STRING", description: "Ngày tháng năm sinh" },
            age: { type: "INTEGER", description: "Tuổi" },
            idNumber: { type: "STRING", description: "Số định danh / CCCD" },
            idIssueDate: { type: "STRING", description: "Ngày cấp" },
            idIssuePlace: { type: "STRING", description: "Nơi cấp" },
            phone: { type: "STRING", description: "Điện thoại" },
            addressDetail: { type: "STRING", description: "Số nhà/thôn/xóm/Địa chỉ" },
            schoolCode: { type: "STRING", description: "Mã cơ sở giáo dục" },
            facilityName: { type: "STRING", description: "Cơ sở kiểm tra sức khoẻ" },
            examinationDate: { type: "STRING", description: "Ngày khám" },
            height: { type: "NUMBER", description: "Chiều cao (cm)" },
            weight: { type: "NUMBER", description: "Cân nặng (kg)" },
            bmi: { type: "STRING", description: "Chỉ số BMI" },
            pulse: { type: "INTEGER", description: "Mạch" },
            bloodPressure: { type: "STRING", description: "Huyết áp" },
            eyeOtherDiseases: { type: "STRING", description: "Khám Mắt - Bệnh khác" },
            entOtherDiseases: { type: "STRING", description: "Khám Tai Mũi Họng - Bệnh khác" },
            upperJawExamination: { type: "STRING", description: "RHM - Hàm trên" },
            lowerJawExamination: { type: "STRING", description: "RHM - Hàm dưới" },
            dentalOtherDiseases: { type: "STRING", description: "RHM - Bệnh khác" },
            prolongedSadnessAnxietyInsomniaNote: { type: "STRING", description: "Sự buồn bã, lo âu kéo dài, mất ngủ" },
            abnormalBehaviorSelfHarmRiskNote: { type: "STRING", description: "Hành vi bất thường, tự hủy hoại bản thân" },
            healthIssuesNote: { type: "STRING", description: "Kết luận - Các vấn đề sức khỏe" },
            referToFacilityDetail: { type: "STRING", description: "Chuyển tuyến cơ sở KBCB" }
          }
        }
      };

    } else {
      // Logic cũ cho Người lớn (ADULT_18)
      prompt = `Bạn là một chuyên gia đọc hồ sơ khám sức khỏe. Hãy đọc các trang scan và nhóm lại theo từng bệnh nhân (dựa vào Tên, Năm sinh, Mã ID).
Trích xuất thông tin thành MẢNG JSON tuyệt đối chính xác theo cấu trúc dưới đây.

CÁC QUY TẮC BẮT BUỘC:
1. Hành chính: Ghi hoa toàn bộ HO_TEN. GIOI_TINH ghi "Nam" hoặc "Nữ". NGAY_SINH định dạng DD/MM/YYYY. MA_DAN_TOC mặc định "Kinh".
2. Lâm sàng: Nếu có chữ "BT", "B.thường", hoặc đóng dấu "Hiện tại chưa phát hiện bất thường" -> BẮT BUỘC ghi là "Hiện tại chưa phát hiện bất thường".
3. Nha khoa: Dịch rõ. VD "Mất R36" -> "Mất răng số 36".
4. Phân loại (PL): Mọi số La Mã (I, II, III, IV, V) hoặc "Loại I" phải đổi thành số Ả Rập (1, 2, 3, 4, 5). 
5. Cận lâm sàng: Tìm kỹ ở các trang "Phiếu Kết Quả Xét Nghiệm" và ghi chính xác con số (Đường máu, Urê, Creatinin...).
6. Tiền sử bệnh: Nếu không có hoặc không đánh dấu, mặc định các trường Tiền sử là "Không".
7. Kết luận: Ghi đầy đủ các bệnh lý vào KET_LUAN_BENH. Không dùng chữ viết tắt.
8. Ranh giới hồ sơ (QUAN TRỌNG): Mỗi bệnh nhân là một tập hồ sơ độc lập. Trang bắt đầu của một người mới thường có chữ "GIẤY KHÁM SỨC KHỎE", "SỔ KHÁM SỨC KHỎE" hoặc ảnh chân dung. Hãy dò tìm chính xác trang bắt đầu và kết thúc của từng người.

ĐỊNH DẠNG JSON ĐẦU RA (Không kèm markdown, chỉ có mảng JSON):
[
  {
    "page_start": <số thứ tự trang bắt đầu, tính từ 0>,
    "page_end": <số thứ tự trang kết thúc của người này>,
    "HO_TEN": "Họ và tên", "GIOI_TINH": "Nam/Nữ", "NGAY_SINH": "DD/MM/YYYY", "MA_DAN_TOC": "Kinh",
    "SO_CCCD": "Số CCCD", "NGAYCAP_CCCD": "", "NOICAP_CCCD": "", 
    "DIA_CHI": "Địa chỉ", "NOI_LAM_VIEC_HOC_TAP": "Nơi làm việc", "DIEN_THOAI": "Số điện thoại", "NHOM_MAU": "Nhóm máu",
    
    "CHIEU_CAO": "Chiều cao (cm)", "CAN_NANG": "Cân nặng (kg)", "CHI_SO_BMI": "BMI", 
    "MACH": "Mạch", "HUYET_AP": "Huyết áp (VD: 120/80)", "KHAM_THE_LUC_PL": "Phân loại thể lực (1-5)",
    
    "NOI_KHOA_TUAN_HOAN": "Tuần hoàn", "NOI_KHOA_TUAN_HOAN_PL": "1-5",
    "NOI_KHOA_HO_HAP": "Hô hấp", "NOI_KHOA_HO_HAP_PL": "1-5",
    "NOI_KHOA_TIEU_HOA": "Tiêu hóa", "NOI_KHOA_TIEU_HOA_PL": "1-5",
    "NOI_KHOA_THAN_TN_SD": "Thận - Tiết niệu", "NOI_KHOA_THAN_TIETNIEU_PL": "1-5",
    "NOI_KHOA_NOI_TIET": "Nội tiết", "NOI_KHOA_NOI_TIET_PL": "1-5",
    "NOI_KHOA_CO_XUONG_KHOP": "Cơ xương khớp", "NOI_KHOA_CO_XUONG_KHOP_PL": "1-5",
    "NOI_KHOA_THAN_KINH": "Thần kinh", "NOI_KHOA_THAN_KINH_PL": "1-5",
    "NOI_KHOA_TAM_THAN": "Tâm thần", "NOI_KHOA_TAM_THAN_PL": "1-5",
    "KET_QUA_KHAM_NGOAI_KHOA": "Ngoại khoa", "KHAM_NGOAI_KHOA_PL": "1-5",
    "KET_QUA_KHAM_DA_LIEU": "Da liễu", "KHAM_DA_LIEU_PL": "1-5",
    
    "KHONG_KINH_MAT_PHAI": "Không kính phải", "KHONG_KINH_MAT_TRAI": "Không kính trái", 
    "CO_KINH_MAT_PHAI": "Có kính phải", "CO_KINH_MAT_TRAI": "Có kính trái",
    "BENH_KHAC_MAT": "Bệnh về mắt", "KHAM_MAT_PL": "1-5",
    
    "TAI_TRAI_NOI_THUONG": "Tai trái thường", "TAI_PHAI_NOI_THUONG": "Tai phải thường",
    "TAI_TRAI_NOI_THAM": "Tai trái thầm", "TAI_PHAI_NOI_THAM": "Tai phải thầm", 
    "BENH_KHAC_TAI_MUI_HONG": "Bệnh TMH", "KHAM_TAI_MUI_HONG_PL": "1-5",
    
    "HAM_TREN": "Hàm trên", "HAM_DUOI": "Hàm dưới", "BENH_KHAC_RANG_HAM_MAT": "Bệnh RHM khác", "KHAM_RANG_HAM_MAT_PL": "1-5",
    
    "PHAN_LOAI_SK": "Phân loại chung (1-5)",
    "KET_LUAN_BENH": "Ghi toàn bộ bệnh lý rõ ràng",
    "CAC_BENH_TAT_NEU_CO": "Tương tự kết luận bệnh"
  }
]`;
      // Không ép Schema cho 18+ để giữ nguyên độ ổn định của prompt text hiện tại.
    }

    // 3. GỌI API GEMINI
    const requestBody: any = {
      contents: [{ parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: { 
        temperature: 0,
        responseMimeType: "application/json" 
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    // Chỉ chèn responseSchema nếu có (tránh lỗi với cấu hình cũ)
    if (responseSchema) {
      requestBody.generationConfig.responseSchema = responseSchema;
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textResult) throw new Error("AI không trả về kết quả hợp lệ.");

    const cleanJsonText = textResult.replace(/```json/g, "").replace(/```/g, "").trim();
    const rawPatients = JSON.parse(cleanJsonText);

    let cleanedPatients = rawPatients;

    // ==========================================
    // 4. CHỈ CHẠY LOGIC CHUẨN HÓA DỮ LIỆU CHO HỒ SƠ 18+
    // ==========================================
    if (docType === "ADULT_18") {
      cleanedPatients = rawPatients.map((patient: any) => {
        const p = { ...patient };

        // XỬ LÝ TAI (NÓI THƯỜNG & NÓI THẦM)
        const cleanDistance = (val: any, defaultVal: string) => {
          if (!val || String(val).trim() === "") return defaultVal;
          let cleaned = String(val).replace(/[mM\s]/g, "").replace(",", ".").trim();
          return cleaned || defaultVal;
        };

        p["TAI_PHAI_NOI_THUONG"] = cleanDistance(p["TAI_PHAI_NOI_THUONG"], "5");
        p["TAI_TRAI_NOI_THUONG"] = cleanDistance(p["TAI_TRAI_NOI_THUONG"], "5");
        p["TAI_PHAI_NOI_THAM"]   = cleanDistance(p["TAI_PHAI_NOI_THAM"], "0.5");
        p["TAI_TRAI_NOI_THAM"]   = cleanDistance(p["TAI_TRAI_NOI_THAM"], "0.5");

        // LOGIC ÉP PHÂN LOẠI SỨC KHỎE (1-5)
        const clinicalPairs = [
          ["NOI_KHOA_TUAN_HOAN", "NOI_KHOA_TUAN_HOAN_PL"],
          ["NOI_KHOA_HO_HAP", "NOI_KHOA_HO_HAP_PL"],
          ["NOI_KHOA_TIEU_HOA", "NOI_KHOA_TIEU_HOA_PL"],
          ["NOI_KHOA_THAN_TN_SD", "NOI_KHOA_THAN_TIETNIEU_PL"],
          ["NOI_KHOA_NOI_TIET", "NOI_KHOA_NOI_TIET_PL"],
          ["NOI_KHOA_CO_XUONG_KHOP", "NOI_KHOA_CO_XUONG_KHOP_PL"],
          ["NOI_KHOA_THAN_KINH", "NOI_KHOA_THAN_KINH_PL"],
          ["NOI_KHOA_TAM_THAN", "NOI_KHOA_TAM_THAN_PL"],
          ["KET_QUA_KHAM_NGOAI_KHOA", "KHAM_NGOAI_KHOA_PL"],
          ["KET_QUA_KHAM_DA_LIEU", "KHAM_DA_LIEU_PL"],
          ["BENH_KHAC_MAT", "KHAM_MAT_PL"],
          ["BENH_KHAC_TAI_MUI_HONG", "KHAM_TAI_MUI_HONG_PL"],
          ["BENH_KHAC_RANG_HAM_MAT", "KHAM_RANG_HAM_MAT_PL"]
        ];

        clinicalPairs.forEach(([descKey, plKey]) => {
          const descVal = String(p[descKey] || "").toLowerCase().trim();
          const plVal = String(p[plKey] || "").trim();

          if (!descVal || descVal.includes("bình thường") || descVal.includes("bất thường") || descVal === "bt") {
            p[plKey] = "1";
          } else {
            if (["1", "I", "|"].includes(plVal)) p[plKey] = "1";
            else if (["2", "II", "11", "||"].includes(plVal)) p[plKey] = "2";
            else if (["3", "III", "111", "|||"].includes(plVal)) p[plKey] = "3";
            else if (["4", "IV", "1V", "14"].includes(plVal)) p[plKey] = "4";
            else if (["5", "V", "15"].includes(plVal)) p[plKey] = "5";
          }
        });

        if (!p["KHAM_THE_LUC_PL"] || String(p["KHAM_THE_LUC_PL"]).trim() === "") p["KHAM_THE_LUC_PL"] = "1";
        if (!p["PHAN_LOAI_SK"] || String(p["PHAN_LOAI_SK"]).trim() === "") p["PHAN_LOAI_SK"] = "1";

        return p;
      });
    } else if (docType === "STUDENT") {
      // Bạn có thể thêm các logic làm sạch dữ liệu riêng cho Học Sinh vào đây sau này
    }

    return NextResponse.json({ patients: cleanedPatients });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}