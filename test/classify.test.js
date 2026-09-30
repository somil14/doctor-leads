import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySpecialty,
  exclusionReason,
  detectEntityType,
  computePriority,
  SPECIALTIES,
} from "../src/classify.js";

const rec = (name, extra = {}) => ({ name, types: [], primaryType: "", matchedTerms: [], ...extra });

test("classifySpecialty matches keywords in the name", () => {
  const cases = {
    "Dr. R K Singh Child Specialist": "Pediatrics",
    "Paediatric Care Centre": "Pediatrics",
    "Maa Maternity & Gynae Clinic": "Gynecology",
    "Saharsa Bone and Joint Clinic": "Orthopedics",
    "Dr. Alok ENT Clinic": "ENT",
    "Skin Care Clinic": "Dermatology",
    "Diabetes Care Centre": "Diabetology",
    "Heart Care Saharsa": "Cardiology",
    "Chest & TB Clinic": "Chest",
    "Smile Dental Clinic": "Dental",
    "Dr. S Jha, General Physician": "GP/Physician",
    "Surya Hospital": "Hospital/Nursing Home",
    "Gayatri Nursing Home": "Hospital/Nursing Home",
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(classifySpecialty(rec(name)), expected, name);
    assert.ok(SPECIALTIES.includes(expected));
  }
});

test("classifySpecialty prefers the specific specialty over Hospital and GP", () => {
  assert.equal(classifySpecialty(rec("Dr. Kumar Child Hospital")), "Pediatrics");
  assert.equal(classifySpecialty(rec("Chest Physician Dr. Rao")), "Chest");
  assert.equal(classifySpecialty(rec("City Orthodontic Centre")), "Dental");
  assert.equal(classifySpecialty(rec("Patient Care Clinic")), "Unknown");
});

test("classifySpecialty falls back to Places types", () => {
  assert.equal(classifySpecialty(rec("Smile Point", { primaryType: "dentist" })), "Dental");
  assert.equal(
    classifySpecialty(rec("Jeevan Jyoti", { types: ["hospital", "health"] })),
    "Hospital/Nursing Home"
  );
});

test("search terms outrank the unreliable hospital type", () => {
  assert.equal(
    classifySpecialty(
      rec("Dr P Jha Clinic", { primaryType: "hospital", matchedTerms: ["pediatrician"] })
    ),
    "Pediatrics"
  );
  assert.equal(
    classifySpecialty(rec("Smile Point", { primaryType: "dentist", matchedTerms: ["ENT doctor"] })),
    "Dental"
  );
  assert.equal(classifySpecialty(rec("Little Baby Clinic", { primaryType: "hospital" })), "Pediatrics");
});

test("classifySpecialty falls back to the search terms that found the place", () => {
  assert.equal(
    classifySpecialty(rec("Dr. Ramesh Kumar", { matchedTerms: ["doctor", "cardiologist"] })),
    "Cardiology"
  );
  assert.equal(
    classifySpecialty(
      rec("Dr. Ramesh Kumar", {
        matchedTerms: ["cardiologist", "physician", "general physician", "MBBS doctor"],
      })
    ),
    "GP/Physician"
  );
  assert.equal(
    classifySpecialty(rec("Dr. Ramesh Kumar", { matchedTerms: ["chest physician"] })),
    "Chest"
  );
  assert.equal(
    classifySpecialty(rec("Dr. Ramesh Kumar", { matchedTerms: ["doctor", "clinic"] })),
    "Unknown"
  );
});

test("the name outranks search terms", () => {
  assert.equal(
    classifySpecialty(rec("Dr. Anita Women's Clinic", { matchedTerms: ["cardiologist"] })),
    "Gynecology"
  );
});

test("exclusionReason excludes pure pharmacies, labs and vets", () => {
  assert.equal(exclusionReason(rec("Shree Medical Hall")), "pharmacy");
  assert.equal(exclusionReason(rec("Apollo Pharmacy")), "pharmacy");
  assert.equal(exclusionReason(rec("Jeevan Aushadhi", { primaryType: "pharmacy" })), "pharmacy");
  assert.equal(exclusionReason(rec("City Pathology")), "diagnostic_lab");
  assert.equal(exclusionReason(rec("Saharsa Diagnostic Centre")), "diagnostic_lab");
  assert.equal(exclusionReason(rec("Pet Care Clinic")), "veterinary");
  assert.equal(
    exclusionReason(rec("Dr. Pashu Chikitsalaya", { primaryType: "veterinary_care" })),
    "veterinary"
  );
});

test("exclusionReason keeps providers that also mention a pharmacy or lab", () => {
  assert.equal(exclusionReason(rec("Surya Hospital & Diagnostic Centre")), null);
  assert.equal(exclusionReason(rec("Dr. Jha Clinic and Medical Store")), null);
  assert.equal(exclusionReason(rec("Life Care Clinic", { primaryType: "pharmacy" })), null);
  assert.equal(exclusionReason(rec("Dr. A Kumar")), null);
});

test("a doctor's name in brackets does not rescue a lab or pharmacy", () => {
  assert.equal(
    exclusionReason(rec("City Imaging & Diagnostics (DR. A KUMAR) Saharsa")),
    "diagnostic_lab"
  );
  assert.equal(exclusionReason(rec("A.B HEALTHCARE (Medical shop)")), "pharmacy");
});

test("detectEntityType looks for a leading Dr./Dr", () => {
  assert.equal(detectEntityType("Dr. A Kumar"), "individual_doctor");
  assert.equal(detectEntityType("Dr A Kumar"), "individual_doctor");
  assert.equal(detectEntityType("DR.A KUMAR"), "individual_doctor");
  assert.equal(detectEntityType(" dr (Mrs) Rani"), "individual_doctor");
  assert.equal(detectEntityType("Drishti Eye Care"), "clinic_or_hospital");
  assert.equal(detectEntityType("Clinic of Dr. A Kumar"), "clinic_or_hospital");
  assert.equal(detectEntityType("Surya Hospital"), "clinic_or_hospital");
});

test("computePriority applies the A/B/C thresholds", () => {
  assert.equal(computePriority("GP/Physician", 20), "A");
  assert.equal(computePriority("Pediatrics", 150), "A");
  assert.equal(computePriority("Gynecology", 19), "B");
  assert.equal(computePriority("Cardiology", 500), "B");
  assert.equal(computePriority("Hospital/Nursing Home", 5), "B");
  assert.equal(computePriority("GP/Physician", 4), "C");
  assert.equal(computePriority("Unknown", 0), "C");
});
