import axios from "axios";
import { Parent, Student, Teacher } from "../models/index.js";

'use-strict'

const resetPinsGenerated = new Map();

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


const generateResetCode = () => {
    let passcode = '';
    for (let i = 0; i < 6; i++) {
        passcode += Math.floor(Math.random() * 10);
    }
    return passcode;
}
const sendResetPin = async (contact, indexNumber) => {

    const code = generateResetCode();
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
                response.data.data
                result = response.data.data.map(obj => (
                    {
                        ...obj
                    }
                ))
            })
            .catch((error) => {
                console.error(error.response.data);
                throw new Error("Failed to send reset pin, contact administration");
            });
    resetPinsGenerated.set(indexNumber, {
        pin: code,
        expiresIn: Date.now() + 30 * 60 * 1000
    });
    return result
}

const verifyResetPin = (indexNumber, pin) => {
    console.log(resetPinsGenerated.get(indexNumber))
    if (!resetPinsGenerated.has(indexNumber)) {
        return false;
    }
    const { expiresIn } = resetPinsGenerated.get(indexNumber);
    if (expiresIn < Date.now()) {
        return false;
    }
    return resetPinsGenerated.get(indexNumber).pin === pin
}

//cron job to clear expired pins every 15 minutes
setInterval(() => {
    resetPinsGenerated.forEach((value, key) => {
        if (value.expiresIn < Date.now()) {
            resetPinsGenerated.delete(key);
        }
    })
}, 15 * 60 * 1000)


export {
    getStudentContact,
    getTeacherContact,
    sendResetPin,
    verifyResetPin
}