import axios from "axios";
import { Parent, Student, Teacher } from "../models/index.js";
import { issueResetCode, verifyResetCode } from "./resetCode.js";

'use-strict'

// The parent-app PIN flow now uses the SAME unified secure store as the admin
// OTP flow (CSPRNG 6-digit, bcrypt-hashed, single-use, attempt-capped,
// server-side cooldown + daily cap). The old in-memory Map + Math.random +
// per-process setInterval GC have been removed; expiry is enforced on read.
//
// The request/response CONTRACTS for /get-pin, /verify-pin and /update-pin are
// unchanged so the existing parent app keeps working. Internally we still key
// codes by the full `ROLE/ID` index number, split into identifier + userType.

const PIN_USER_TYPE = "PORTAL"; // discriminator for parent-app PIN codes

// Split a `ROLE/ID` index number into the store's identifier + a type tag.
// Falls back gracefully if a bare id is passed.
const splitIndex = (indexNumber) => {
    const value = String(indexNumber ?? "");
    const parts = value.split("/");
    if (parts.length === 2) {
        return { identifier: `${parts[0]}/${parts[1]}`, userType: PIN_USER_TYPE };
    }
    return { identifier: value, userType: PIN_USER_TYPE };
};

const getStudentContact = async (id) => {
    const getStudentParentId = await Student.findOne({
        where: {
            student_id: id
        },
        attributes: ["parent_id"],
        raw: true
    })
    const parentContacts = await Parent.findOne({
        where: {
            parent_id: getStudentParentId.parent_id
        },
        attributes: ["contact", "contact1"],
        raw: true
    });
    return parentContacts.contact || parentContacts.contact1 || "";
}

const getTeacherContact = async (id) => {
    const teacherContacts = await Teacher.findOne({
        where: {
            teacher_id: id
        },
        attributes: ["phone"],
        raw: true
    });
    return teacherContacts.phone || "";
}

// Generate + store a code via the unified store, then SMS it. Returns the
// Arkesel send result (shape preserved for the existing `{ sent, status }`
// response). Resend cooldown / daily-cap violations bubble up as AppError(429).
const sendResetPin = async (contact, indexNumber) => {
    const { identifier, userType } = splitIndex(indexNumber);
    const code = await issueResetCode({ identifier, userType });

    const data = {
        sender: "P Peace",
        message: `Your reset pin is ${code}`,
        recipients: contact,
    };

    let result;
    await axios
        .post("https://sms.arkesel.com/api/v2/sms/send", data, {
            headers: {
                "api-key": process.env.ARKESEL_KEY,
            },
        })
        .then((response) => {
            result = response.data.data.map(obj => ({ ...obj }))
        })
        .catch(() => {
            // Do not log raw provider responses (may contain recipient PII).
            throw new Error("Failed to send reset pin, contact administration");
        });
    return result
}

// Async now (bcrypt.compare + DB lookup). Returns a boolean — the controllers
// keep returning `{ valid }` so the parent app contract is unchanged.
//
// The parent app verifies the pin twice: once at the /verify-pin step (to
// advance the UI) and again at /update-pin (to actually change the password).
// We therefore PEEK (consume=false) at /verify-pin and CONSUME (single-use) at
// /update-pin. Failed attempts are still counted/locked in both cases.
const verifyResetPin = async (indexNumber, pin, { consume = false } = {}) => {
    const { identifier, userType } = splitIndex(indexNumber);
    return await verifyResetCode({
        identifier,
        userType,
        code: String(pin ?? ""),
        consume,
    });
}


export {
    getStudentContact,
    getTeacherContact,
    sendResetPin,
    verifyResetPin
}
