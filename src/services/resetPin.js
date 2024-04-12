import axios from "axios";
import { Parent, Teacher } from "../models/index.js";

'use-strict'

const getStudentContact = async (id) => {
    return await Parent.findOne({
        where: {
            student_id: id
        },
        attributes: ["contact"]
    });
}

const getTeacherContact = async (id) => {
    return await Teacher.findOne({
        where: {
            teacher_id: id
        },
        attributes: ["phone"]
    });
}


const generateResetCode = () => {
    let passcode = '';
    for (let i = 0; i < 4; i++) {
        passcode += Math.floor(Math.random() * 10);
    }
    return passcode;
}
const sendResetPin = async (contact) => {

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
                    "api-key": process.env.SMS_API_KEY || "c0tQU0hjU2JST3hwa2hxRHRRYnk",
                },
            })
            .then((response) => {
                response.data.data
                result = response.data.data.map(obj => (
                    {
                        ...obj,
                        pin: code
                    }
                ))
            })
            .catch((error) => {
                console.error(error);
            });

    return result
}


export {
    getStudentContact,
    getTeacherContact,
    sendResetPin
}